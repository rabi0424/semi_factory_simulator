import {
  MAP_COLS, MAP_ROWS, MACHINE_DEFS,
  MIN_CLEANLINESS, SCRAP_THRESHOLD, YIELD_WINDOW, UTIL_TAU,
  DEFAULT_SPAWN_INTERVAL, STOCKER_CAP,
  FURNACE_BATCH, FURNACE_WAIT,
  PM_THRESHOLD, PM_TIME, SAVE_VERSION,
  START_MONEY, OHT_COST, RAIL_COST, SELL_RATIO, MAX_GEN, MAX_FLEET,
  PRODUCTS, PRODUCT_ORDER, stepsOf, servesOf,
  nodePriceMul, nodeLabel, NODE_DEFS,
  LITHO_KINDS, lithoTierOf, minLithoTier, singleLithoTier, lithoPasses, metalNeedsCu,
  FRESH_TAU, LEARN_PENALTY, LEARN_TAU,
  rotSize, rotPorts,
} from './config';
import type { MachineKind, ProductId } from './config';
import { RailNetwork, tkey } from './rail';
import type { TileKey } from './rail';
import { Fleet, portKey } from './oht';
import type { VehState } from './oht';

export interface Lot {
  id: number;
  product: ProductId;
  step: number;    // 次に受ける工程。レシピ長なら出荷待ち
  yield_: number;  // 0..1
  gen: number;     // 投入時のプロセス世代(このロットのレシピ段数を決める)
  expoTier: number;// 投入時の露光ティア(MP展開でレシピ段数が変わる)
}

// 生産ラインの設定。投入ステーション1台ぶんの「作るもの」を定義する。
// 複数の投入ステーションを置いて製品を作り分ける
export interface LineConfig {
  product: ProductId;
  gen: number;      // 生産ノード(研究済みのみ)
  expo: number;     // 露光ティア指定。-1 = 自動(所有機から最適を選択)
  interval: number; // 投入間隔 [秒]
  timer: number;    // 内部タイマー
}

// 出力ポートに載ったFOUPが次工程へ搬送できず滞留している理由。
// 空きが出るのを待つだけの正常な滞留(全台が処理中/整備中)には付けない。
export interface StallInfo {
  kind: MachineKind;                      // 行き先として求めている装置種別
  reason: 'noroute' | 'missing';          // 経路なし / 対応装置が未設置
}

export interface Port {
  machine: Machine;
  col: number;      // 絶対タイル座標
  row: number;
  fx: number;       // ポートの外側方向(描画用)
  fy: number;
  io: 'in' | 'out';
  foup: Lot | null;
  reserved: boolean; // in: 搬送予約済み / out: ビークル引き取り予約済み
  readyAt: number;   // outポートにFOUPが載った時刻(搬送待ち統計用)
}

export interface Machine {
  id: number;
  kind: MachineKind;
  label: string;   // 銘板表示(例: KrF-2)
  col: number;
  row: number;
  rot: number;     // 0=南向きポート, 90°CW単位
  w: number;       // 回転後フットプリント
  h: number;
  busy: Lot[];     // 処理中ロット(拡散炉は最大3、他は最大1)
  procLeft: number;
  holdQueue: Lot[]; // 処理完了したが出力ポート待ちのロット
  batch: Lot[];     // 拡散炉の装填待ちロット
  batchTimer: number;
  cleanliness: number;
  pm: boolean;           // 自動整備(PM)中
  pmLeft: number;        // >0 なら整備の残り時間
  jobs: number;
  util: number;          // 稼働率(直近~45秒のEMA、0..1)
  ports: Port[];
  stall: StallInfo | null; // 出力FOUPが次工程へ搬送できず滞留している理由(無ければnull)
  storage: Lot[];        // ストッカーの内部保管棚
  line: LineConfig | null; // 投入ステーションの生産ライン設定
}

export interface Stats {
  money: number;
  wip: number;
  completed: number;
  scrapped: number;
  throughput: number;
  avgYield: number;
  avgWait: number;       // 平均搬送待ち [秒]
  ohtTotal: number;
  ohtSize: number;
  ohtIdle: number;
  pm: number;            // 整備中の装置数
}

// 研究の進行状態
export interface ResearchJob {
  type: 'node' | 'product';
  node: number;          // type==='node' のとき対象gen
  product: ProductId;    // type==='product' のとき対象製品
  timeLeft: number;
  total: number;
}

let nextId = 1;

const zeroByProduct = (): Record<ProductId, number> => ({
  diode: 0, logic: 0, power: 0, imgsensor: 0, dram: 0, flash: 0, cpu: 0, gpu: 0,
});
const nodeArray = (): number[] => new Array(MAX_GEN + 1).fill(0);
const shippedInit = (): Record<ProductId, number[]> => {
  const o = {} as Record<ProductId, number[]>;
  for (const id of PRODUCT_ORDER) o[id] = nodeArray();
  return o;
};

// 投入ステーションの既定ライン設定
function defaultLine(): LineConfig {
  return { product: 'diode', gen: 0, expo: -1, interval: DEFAULT_SPAWN_INTERVAL, timer: 0 };
}

// ノードのウェハ原価倍率(先端ほど高い)
function waferCostOf(product: ProductId, gen: number): number {
  return Math.round(PRODUCTS[product].waferCost * Math.pow(1.12, gen));
}

export class Game {
  machines: Machine[] = [];
  lots: Lot[] = [];
  rail = new RailNetwork();
  fleet = new Fleet(this.rail);
  // 装置のロードポートが乗るタイル一覧。アイドル中のOHTがポート上に
  // 居座って積み下ろしを永久に妨げないよう、徘徊時に避けるために使う
  portTiles = new Set<TileKey>();
  simTime = 0;
  paused = false;
  speed = 1;
  money = START_MONEY;
  spawnInterval = DEFAULT_SPAWN_INTERVAL; // 新規投入ステーションの既定間隔
  private dispatchTimer = 0;
  private histTimer = 0;
  private completions: { t: number; y: number }[] = [];
  completedCount = 0;
  scrappedCount = 0;
  recentYields: number[] = []; // 直近完成ロットの歩留まり(移動平均用)

  // ---- 技術ツリー(研究)----
  nodesUnlocked = new Set<number>([0]);              // 研究済みプロセスノード(gen)
  productsUnlocked = new Set<ProductId>(['diode']);  // 研究済み製品
  research: ResearchJob | null = null;               // 進行中の研究(同時1件)

  // ---- 実績・市場・学習 ----
  completedByProduct = zeroByProduct();
  // 製品×ノードの累計出荷数(市場鮮度=値崩れの元)
  shippedByNode = shippedInit();
  // ノード単位の累計完成数(歩留まり学習曲線。ファブ共通)
  nodeCompleted = nodeArray();

  waitSamples: number[] = [];       // 搬送待ち時間の直近サンプル
  tpHistory: number[] = [];         // 5秒おきのスループット履歴(スパークライン用)
  onMessage: (msg: string) => void = () => {};
  // 旧バージョンのセーブを移行したときの注意書き(main側でトースト表示)
  migrationNotice: string | null = null;

  constructor() {
    this.wireFleet();
    this.initStations();
  }

  // FOUPピックアップ時に搬送待ち時間を記録
  private wireFleet() {
    this.fleet.onPickup = (port: Port) => {
      if (port.io === 'out' && port.readyAt >= 0) {
        this.waitSamples.push(this.simTime - port.readyAt);
        if (this.waitSamples.length > 50) this.waitSamples.shift();
      }
    };
  }

  private initStations() {
    this.addMachine('load', 2, 9, 0, true);
    this.addMachine('ship', MAP_COLS - 4, 9, 0, true);
  }

  // ---- 配置 ----

  machineAtTile(c: number, r: number): Machine | undefined {
    return this.machines.find(
      (m) => c >= m.col && c < m.col + m.w && r >= m.row && r < m.row + m.h,
    );
  }

  canPlace(kind: MachineKind, col: number, row: number, rot: number): boolean {
    const { w, h } = rotSize(MACHINE_DEFS[kind], rot);
    for (let dc = 0; dc < w; dc++) {
      for (let dr = 0; dr < h; dr++) {
        const c = col + dc;
        const r = row + dr;
        if (c < 0 || r < 0 || c >= MAP_COLS || r >= MAP_ROWS) return false;
        if (this.machineAtTile(c, r)) return false;
      }
    }
    return true;
  }

  // 購入可能か(設置ゴーストの色分けにも使う)
  canAfford(kind: MachineKind): boolean {
    return MACHINE_DEFS[kind].cost <= this.money;
  }

  addMachine(
    kind: MachineKind, col: number, row: number, rot = 0, force = false,
  ): Machine | null {
    if (!force && !this.canPlace(kind, col, row, rot)) {
      this.onMessage('そこには設置できません');
      return null;
    }
    if (!force && !this.canAfford(kind)) {
      this.onMessage(
        `資金不足: ${MACHINE_DEFS[kind].name} は ¥${MACHINE_DEFS[kind].cost.toLocaleString()}`,
      );
      return null;
    }
    const def = MACHINE_DEFS[kind];
    if (!force) this.money -= def.cost;
    const { w, h } = rotSize(def, rot);
    const serial = this.machines.filter((x) => x.kind === kind).length + 1;
    const m: Machine = {
      id: nextId++, kind, label: `${def.short}-${serial}`, col, row, rot, w, h,
      busy: [], procLeft: 0, holdQueue: [], batch: [], batchTimer: 0,
      cleanliness: 1, pm: false, pmLeft: 0, jobs: 0, util: 0,
      ports: [], stall: null, storage: [],
      line: kind === 'load' ? defaultLine() : null,
    };
    m.ports = rotPorts(def, rot).map((p) => ({
      machine: m, col: col + p.dx, row: row + p.dy,
      fx: p.fx, fy: p.fy,
      io: p.io, foup: null, reserved: false, readyAt: -1,
    }));
    this.machines.push(m);
    this.rebuildPortTiles();
    return m;
  }

  private rebuildPortTiles() {
    this.portTiles = new Set(
      this.machines.flatMap((m) => m.ports.map((p) => tkey(p.col, p.row))),
    );
  }

  removeMachine(m: Machine): boolean {
    // ステーションは最後の1台なら撤去不可(投入/出荷の口が無くなるのを防ぐ)
    if (m.kind === 'load' || m.kind === 'ship') {
      if (this.machines.filter((x) => x.kind === m.kind).length <= 1) {
        this.onMessage(
          m.kind === 'load' ? '投入ステーションは最低1台必要です' : '出荷ステーションは最低1台必要です',
        );
        return false;
      }
    }
    if (
      m.busy.length > 0 || m.holdQueue.length > 0 || m.batch.length > 0 ||
      m.storage.length > 0 || m.ports.some((p) => p.foup || p.reserved)
    ) {
      this.onMessage('ロットが残っている装置は撤去できません');
      return false;
    }
    this.machines = this.machines.filter((x) => x !== m);
    this.rebuildPortTiles();
    this.money += MACHINE_DEFS[m.kind].cost * SELL_RATIO;
    return true;
  }

  // レール敷設(ドラッグ経路の一括購入)。既存エッジは課金しない。
  // 資金が足りなければ1区間も敷かずに全体を拒否する
  buyRailPath(path: TileKey[]): boolean {
    const newEdges: [TileKey, TileKey][] = [];
    const seen = new Set<string>();
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1];
      const b = path[i];
      const key = `${a}>${b}`;
      if (this.rail.hasEdge(a, b) || seen.has(key)) continue;
      seen.add(key);
      newEdges.push([a, b]);
    }
    const cost = newEdges.length * RAIL_COST;
    if (cost > this.money) {
      this.onMessage(`資金不足: レール${newEdges.length}区間は ¥${cost.toLocaleString()}`);
      return false;
    }
    this.money -= cost;
    for (const [a, b] of newEdges) this.rail.addEdge(a, b);
    return true;
  }

  removeRailTile(c: number, r: number) {
    const k = tkey(c, r);
    if (this.fleet.isOccupied(k)) {
      this.onMessage('ビークルがいる区間は撤去できません');
      return;
    }
    const removed = this.rail.removeTile(k);
    this.money += removed * RAIL_COST * SELL_RATIO;
  }

  buyVehicle(): boolean {
    if (this.fleet.size >= MAX_FLEET) return false;
    if (this.money < OHT_COST) {
      this.onMessage(`資金不足: OHTは1台 ¥${OHT_COST.toLocaleString()}`);
      return false;
    }
    this.money -= OHT_COST;
    this.fleet.size++;
    return true;
  }

  sellVehicle(): boolean {
    if (this.fleet.size <= 0) return false;
    this.fleet.size--;
    this.money += OHT_COST * SELL_RATIO;
    return true;
  }

  // 詰まり救済: 装置に滞留しているFOUP(搬送予約のないポート上・出力待ち・
  // 装填待ち・保管棚)を強制廃棄する。循環待ちデッドロックの脱出弁。
  // 処理中(busy)のロットと、ビークルが向かっている予約済みポートは触らない
  purgeMachine(m: Machine): number {
    const victims: Lot[] = [];
    for (const p of m.ports) {
      if (p.foup && !p.reserved) {
        victims.push(p.foup);
        p.foup = null;
      }
    }
    victims.push(...m.holdQueue, ...m.batch, ...m.storage);
    m.holdQueue = [];
    m.batch = [];
    m.batchTimer = 0;
    m.storage = [];
    if (victims.length === 0) return 0;
    this.scrappedCount += victims.length;
    const gone = new Set(victims);
    this.lots = this.lots.filter((l) => !gone.has(l));
    return victims.length;
  }

  // ---- 技術ツリー(研究)----

  // ノード研究の可否。前ノードが研究済みで、未研究、研究枠が空いていること
  canResearchNode(gen: number): boolean {
    if (gen < 1 || gen > MAX_GEN) return false;
    if (this.nodesUnlocked.has(gen)) return false;
    if (!this.nodesUnlocked.has(gen - 1)) return false;
    return true;
  }

  startNodeResearch(gen: number): boolean {
    if (this.research) { this.onMessage('研究は同時に1件までです'); return false; }
    if (!this.canResearchNode(gen)) return false;
    const def = NODE_DEFS[gen];
    if (this.money < def.research) {
      this.onMessage(`資金不足: ${def.label} の研究は ¥${def.research.toLocaleString()}`);
      return false;
    }
    this.money -= def.research;
    this.research = { type: 'node', node: gen, product: 'diode', timeLeft: def.researchTime, total: def.researchTime };
    this.onMessage(`🔬 ${def.label} プロセスの研究を開始(${Math.round(def.researchTime)}秒)`);
    return true;
  }

  canResearchProduct(id: ProductId): boolean {
    if (this.productsUnlocked.has(id)) return false;
    const p = PRODUCTS[id];
    if (p.research <= 0) return false;
    if (!p.requires.every((r) => this.productsUnlocked.has(r))) return false;
    if (!this.nodesUnlocked.has(p.reqNode)) return false;
    return true;
  }

  startProductResearch(id: ProductId): boolean {
    if (this.research) { this.onMessage('研究は同時に1件までです'); return false; }
    if (!this.canResearchProduct(id)) return false;
    const p = PRODUCTS[id];
    if (this.money < p.research) {
      this.onMessage(`資金不足: ${p.name} の研究は ¥${p.research.toLocaleString()}`);
      return false;
    }
    this.money -= p.research;
    // 製品研究は所要時間をノード相当より軽めに(工程数に応じて)
    const time = 40 + p.steps.length * 4;
    this.research = { type: 'product', node: 0, product: id, timeLeft: time, total: time };
    this.onMessage(`🔬 「${p.name}」の製品開発を開始(${Math.round(time)}秒)`);
    return true;
  }

  cancelResearch(): boolean {
    if (!this.research) return false;
    // 着手費用の半額を払い戻し(実質サンクコスト回避の弁)
    const cost = this.research.type === 'node'
      ? NODE_DEFS[this.research.node].research
      : PRODUCTS[this.research.product].research;
    this.money += cost * SELL_RATIO;
    this.research = null;
    this.onMessage('研究を中止しました(費用の半額を払い戻し)');
    return true;
  }

  private updateResearch(dt: number) {
    if (!this.research) return;
    this.research.timeLeft -= dt;
    if (this.research.timeLeft > 0) return;
    const r = this.research;
    this.research = null;
    if (r.type === 'node') {
      this.nodesUnlocked.add(r.node);
      const need = LITHO_KINDS[minLithoTier(r.node)];
      const owned = this.machines.some((m) => m.kind === need || lithoTierOf(m.kind) > minLithoTier(r.node));
      this.onMessage(
        `✅ ${nodeLabel(r.node)} プロセスを解禁しました` +
        (owned ? '' : ` ⚠ このノードの露光には「${MACHINE_DEFS[need].name}」が必要です`),
      );
    } else {
      this.productsUnlocked.add(r.product);
      this.onMessage(`🎉 新製品「${PRODUCTS[r.product].name}」を解禁しました`);
    }
  }

  // ---- 更新 ----

  update(rawDt: number) {
    if (this.paused) return;
    const dt = rawDt * this.speed;
    this.simTime += dt;

    this.updateResearch(dt);
    this.updateSpawn(dt);
    for (const m of this.machines) this.updateMachine(m, dt);

    this.dispatchTimer -= dt;
    if (this.dispatchTimer <= 0) {
      this.dispatchTimer = 0.25;
      this.dispatch();
    }
    this.fleet.update(dt, this.portTiles);

    // スループット履歴(5秒粒度、最大10分)
    this.histTimer += dt;
    if (this.histTimer >= 5) {
      this.histTimer = 0;
      this.tpHistory.push(this.currentThroughput());
      if (this.tpHistory.length > 120) this.tpHistory.shift();
    }
  }

  private currentThroughput(): number {
    const horizon = 60;
    const from = this.simTime - horizon;
    this.completions = this.completions.filter((c) => c.t >= from);
    const window = Math.min(horizon, Math.max(this.simTime, 1));
    return (this.completions.length / window) * 60;
  }

  // 露光ティアの解決。指定(expo>=0)なら最低ティアまで引き上げ、自動(-1)なら
  // 所有する露光機から最適(単パターン優先→少パス→安価)を選ぶ
  resolveExpoTier(gen: number, mode: number): number {
    const minT = minLithoTier(gen);
    if (mode >= 0) return Math.max(mode, minT);
    const owned = new Set<number>();
    for (const m of this.machines) {
      const t = lithoTierOf(m.kind);
      if (t >= minT) owned.add(t);
    }
    if (owned.size === 0) return singleLithoTier(gen); // 未所有: 単パターン想定(未設置警告が出る)
    let best = -1;
    let bestPass = Infinity;
    for (const t of owned) {
      const pass = lithoPasses(t, gen);
      if (pass < bestPass || (pass === bestPass && t < best)) {
        bestPass = pass;
        best = t;
      }
    }
    return best;
  }

  private updateSpawn(dt: number) {
    // ストッカーが全て満杯の間はWIPリリースを止める(CONWIP)
    const stockers = this.machines.filter((m) => m.kind === 'stocker');
    const conwipBlocked =
      stockers.length > 0 && stockers.every((s) => s.storage.length >= STOCKER_CAP);

    // 投入ステーションごとに独立して投入(=1台1ライン)
    for (const load of this.machines) {
      if (load.kind !== 'load' || !load.line) continue;
      const line = load.line;
      line.timer += dt;
      if (line.timer < line.interval) continue;
      if (conwipBlocked) continue;
      const port = load.ports.find((p) => p.io === 'out' && !p.foup && !p.reserved);
      if (!port) continue; // 払い出しポートが満杯なら待つ(自然なWIP制限)
      if (!this.productsUnlocked.has(line.product)) continue;
      if (!this.nodesUnlocked.has(line.gen)) continue;
      const waferCost = waferCostOf(line.product, line.gen);
      if (this.money < waferCost) continue; // 原価を払えないなら見送る
      this.money -= waferCost;
      line.timer = 0;
      const expoTier = this.resolveExpoTier(line.gen, line.expo);
      const lot: Lot = {
        id: nextId++, product: line.product, step: 0, yield_: 1,
        gen: line.gen, expoTier,
      };
      this.lots.push(lot);
      port.foup = lot;
      port.readyAt = this.simTime;
    }
  }

  // 出力待ちロットを空いた出力ポートへ
  private flushHold(m: Machine) {
    while (m.holdQueue.length > 0) {
      const out = m.ports.find((p) => p.io === 'out' && !p.foup);
      if (!out) break;
      out.foup = m.holdQueue.shift()!;
      out.readyAt = this.simTime;
    }
  }

  private updateMachine(m: Machine, dt: number) {
    if (m.kind === 'load') return;

    if (m.kind === 'ship') {
      for (const p of m.ports) {
        if (p.foup) {
          const done = p.foup;
          const gen = done.gen;
          // 売上 = 基準単価 × ノード倍率 × 市場鮮度 × 歩留まり
          const fresh = this.freshnessOf(done.product, gen);
          this.money += PRODUCTS[done.product].price * nodePriceMul(gen) * fresh * done.yield_;
          this.completedCount++;
          this.completedByProduct[done.product]++;
          this.shippedByNode[done.product][gen]++;
          this.nodeCompleted[gen]++;
          this.recentYields.push(done.yield_);
          if (this.recentYields.length > YIELD_WINDOW) this.recentYields.shift();
          this.completions.push({ t: this.simTime, y: done.yield_ });
          this.lots = this.lots.filter((l) => l !== done);
          p.foup = null;
        }
      }
      return;
    }

    if (m.kind === 'stocker') {
      for (const p of m.ports) {
        if (p.io === 'in' && p.foup && m.storage.length < STOCKER_CAP) {
          m.storage.push(p.foup);
          p.foup = null;
        }
      }
      for (const p of m.ports) {
        if (p.io === 'out' && !p.foup && m.storage.length > 0) {
          p.foup = m.storage.shift()!;
          p.readyAt = this.simTime;
        }
      }
      return;
    }

    // 稼働率(EMA)。処理中=1、それ以外(整備・待機・出力詰まり)=0 に向けて追従
    const utilTarget = m.busy.length > 0 ? 1 : 0;
    m.util += (utilTarget - m.util) * Math.min(1, dt / UTIL_TAU);

    // 完成品は整備中でも出せるよう先に排出
    this.flushHold(m);

    // 自動整備(PM): 進行して終わったら清浄度が全回復。整備中は新規処理を止める
    if (m.pm) {
      m.pmLeft -= dt;
      if (m.pmLeft <= 0) {
        m.pmLeft = 0;
        m.pm = false;
        m.cleanliness = 1;
      }
      return;
    }

    // 拡散炉のプリステージ: 処理中でも入力ポートから装填バッファへ受け入れる
    if (m.kind === 'furnace') {
      for (const p of m.ports) {
        if (p.io === 'in' && p.foup && m.batch.length < FURNACE_BATCH) {
          m.batch.push(p.foup);
          p.foup = null;
        }
      }
      m.batchTimer = m.batch.length > 0 ? m.batchTimer + dt : 0;
    }

    // 処理の進行
    if (m.busy.length > 0) {
      m.procLeft -= dt;
      if (m.procLeft <= 0) this.finishJob(m);
      return;
    }

    if (m.kind === 'furnace') {
      if (
        m.batch.length > 0 &&
        (m.batch.length >= FURNACE_BATCH || m.batchTimer >= FURNACE_WAIT) &&
        m.holdQueue.length === 0
      ) {
        m.busy = m.batch;
        m.batch = [];
        m.batchTimer = 0;
        m.procLeft = MACHINE_DEFS[m.kind].procTime;
      }
      return;
    }

    // 通常機: 出力が詰まっている間は次の処理を始めない
    if (m.holdQueue.length > 0) return;

    const inPort = m.ports.find((p) => p.io === 'in' && p.foup);
    if (inPort) {
      m.busy = [inPort.foup!];
      inPort.foup = null;
      m.procLeft = MACHINE_DEFS[m.kind].procTime;
    }
  }

  // 製品×ノードの市場鮮度(1=先端で希少、下限=製品ごとのfreshFloor)
  freshnessOf(product: ProductId, gen: number): number {
    const n = this.shippedByNode[product]?.[gen] ?? 0;
    const floor = PRODUCTS[product].freshFloor;
    return floor + (1 - floor) * Math.exp(-n / FRESH_TAU);
  }

  // ノードの歩留まり学習係数(1=習熟済み。立ち上げ直後ほど欠陥倍率が高い)
  learnMul(gen: number): number {
    return 1 + LEARN_PENALTY * Math.exp(-(this.nodeCompleted[gen] ?? 0) / LEARN_TAU);
  }

  private finishJob(m: Machine) {
    const def = MACHINE_DEFS[m.kind];
    const lots = m.busy;
    m.busy = [];
    m.jobs++;

    // 汚れた装置ほど欠陥率が上がる。dirtiness は最大 1-MIN_CLEANLINESS(=0.8)
    const dirtiness = 1 - m.cleanliness;
    m.cleanliness = Math.max(MIN_CLEANLINESS, m.cleanliness - def.wear);

    for (const lot of lots) {
      // 欠陥 = 基礎欠陥 × 汚れ倍率 × ノード学習倍率 × ばらつき
      const defect =
        def.baseDefect * (1 + dirtiness * 4) * this.learnMul(lot.gen) * rand(0.5, 1.5);
      lot.yield_ = Math.max(0, lot.yield_ * (1 - defect));
      lot.step++;

      // 最終工程(検査)完了 → 歩留まり確定。基準未満は廃棄
      const steps = stepsOf(lot.product, lot.gen, lot.expoTier);
      if (lot.step >= steps.length && lot.yield_ < SCRAP_THRESHOLD) {
        this.scrappedCount++;
        this.lots = this.lots.filter((l) => l !== lot);
        continue;
      }
      m.holdQueue.push(lot);
    }

    // 清浄度が閾値を切ったら自動でPM(予防保全)へ。故障・手動修理は無い
    if (m.cleanliness < PM_THRESHOLD) {
      m.pm = true;
      m.pmLeft = PM_TIME;
    }
  }

  // ロットの次工程を担える行き先か。露光ティア/Cu必須/ALDなどの要件も見る
  private canServe(dest: Machine, kind: MachineKind, lot: Lot): boolean {
    if (servesOf(dest.kind) !== kind) return false;
    if (kind === 'litho') return lithoTierOf(dest.kind) >= lot.expoTier;
    if (kind === 'metal' && metalNeedsCu(lot.gen)) return dest.kind === 'cu';
    return true;
  }

  // 「対応装置が未設置」警告に出す代表的な装置種別
  private neededKind(kind: MachineKind, lot: Lot): MachineKind {
    if (kind === 'litho') {
      const t = Math.max(lot.expoTier, minLithoTier(lot.gen));
      return LITHO_KINDS[Math.min(t, LITHO_KINDS.length - 1)];
    }
    if (kind === 'metal' && metalNeedsCu(lot.gen)) return 'cu';
    return kind;
  }

  // 出力ポートのFOUPに搬送ジョブを割り当てる。
  // 工程が進んでいるロットを優先(下流から抜くとグリッドロックしにくい)
  private dispatch() {
    for (const m of this.machines) m.stall = null;

    const pending: { m: Machine; p: Port; progress: number }[] = [];
    for (const m of this.machines) {
      for (const p of m.ports) {
        if (p.io !== 'out' || !p.foup || p.reserved) continue;
        const steps = stepsOf(p.foup.product, p.foup.gen, p.foup.expoTier);
        pending.push({ m, p, progress: p.foup.step / steps.length });
      }
    }
    pending.sort((a, b) => b.progress - a.progress);

    for (const { m, p } of pending) {
      const lot = p.foup!;
      const steps = stepsOf(lot.product, lot.gen, lot.expoTier);
      const kind: MachineKind = lot.step >= steps.length ? 'ship' : steps[lot.step].kind;

      const reach = this.rail.reachableFrom(tkey(p.col, p.row));
      let sawUnreachable = false;
      let anyCapable = false; // 要件も満たす装置が存在するか

      let bestPort: Port | null = null;
      let bestScore = Infinity;
      for (const dest of this.machines) {
        if (kind === 'ship' ? dest.kind !== 'ship' : !this.canServe(dest, kind, lot)) continue;
        anyCapable = true;
        if (dest.pm) continue; // 整備中は一時的に不可(警告は出さない)
        const inPort = dest.ports.find((x) => x.io === 'in' && !x.foup && !x.reserved);
        if (!inPort) continue;
        if (!reach.has(portKey(inPort))) {
          sawUnreachable = true;
          continue;
        }
        const load =
          dest.busy.length + dest.holdQueue.length + dest.batch.length +
          dest.ports.filter((x) => x.io === 'in' && (x.foup || x.reserved)).length;
        const dist = Math.hypot(inPort.col - p.col, inPort.row - p.row);
        const score = load * 1000 + dist;
        if (score < bestScore) {
          bestScore = score;
          bestPort = inPort;
        }
      }

      // 行き先が満杯ならストッカーへ退避(デッドロック回避)
      if (!bestPort && m.kind !== 'stocker') {
        for (const dest of this.machines) {
          if (dest.kind !== 'stocker') continue;
          if (dest.storage.length >= STOCKER_CAP) continue;
          const inPort = dest.ports.find((x) => x.io === 'in' && !x.foup && !x.reserved);
          if (!inPort) continue;
          if (!reach.has(portKey(inPort))) {
            sawUnreachable = true;
            continue;
          }
          const dist = Math.hypot(inPort.col - p.col, inPort.row - p.row);
          if (dist < bestScore) {
            bestScore = dist;
            bestPort = inPort;
          }
        }
      }
      if (!bestPort) {
        // 見落とし由来の滞留だけ警告する(全台処理中/整備中の正常な滞留は無視)
        const dispKind = kind === 'ship' ? 'ship' : this.neededKind(kind, lot);
        if (sawUnreachable) m.stall = { kind: dispKind, reason: 'noroute' };
        else if (!anyCapable) m.stall = { kind: dispKind, reason: 'missing' };
        continue;
      }
      if (this.fleet.tryAssign({ from: p, to: bestPort, lot })) {
        p.reserved = true;
        bestPort.reserved = true;
      }
    }
  }

  getStats(): Stats {
    const throughput = this.currentThroughput();
    const avgYield =
      this.recentYields.length > 0
        ? this.recentYields.reduce((s, y) => s + y, 0) / this.recentYields.length
        : 0;
    const avgWait =
      this.waitSamples.length > 0
        ? this.waitSamples.reduce((s, w) => s + w, 0) / this.waitSamples.length
        : 0;
    return {
      money: this.money,
      wip: this.lots.length,
      completed: this.completedCount,
      scrapped: this.scrappedCount,
      throughput,
      avgYield,
      avgWait,
      ohtTotal: this.fleet.vehicles.length,
      ohtSize: this.fleet.size,
      ohtIdle: this.fleet.idleCount(),
      pm: this.machines.filter((m) => m.pm).length,
    };
  }

  // 1ロットあたりの粗利見積り(損益ダッシュボード用)。原価と現在の鮮度/歩留まり見込み
  estimateProfit(product: ProductId, gen: number, yieldGuess = 0.85): {
    revenue: number; waferCost: number; profit: number; fresh: number;
  } {
    const fresh = this.freshnessOf(product, gen);
    const revenue = PRODUCTS[product].price * nodePriceMul(gen) * fresh * yieldGuess;
    const waferCost = waferCostOf(product, gen);
    return { revenue, waferCost, profit: revenue - waferCost, fresh };
  }

  waferCostOf(product: ProductId, gen: number): number {
    return waferCostOf(product, gen);
  }

  // 製品×世代の工程別仕掛かり(フローパネル用)
  stepWipOf(product: ProductId, gen: number, expoTier?: number): number[] {
    const wip = stepsOf(product, gen, expoTier).map(() => 0);
    for (const lot of this.lots) {
      if (lot.product === product && lot.gen === gen && lot.step < wip.length) {
        wip[lot.step]++;
      }
    }
    return wip;
  }

  // 表示世代と異なる世代/製品で流れている同製品ロット数(移行期の残存分)
  otherGenWipOf(product: ProductId, gen: number): number {
    let n = 0;
    for (const lot of this.lots) {
      if (lot.product === product && lot.gen !== gen) n++;
    }
    return n;
  }

  // 工程種別の平均稼働率(ボトルネック診断用)。担う装置が無ければ null
  kindUtil(kind: MachineKind): number | null {
    let sum = 0;
    let n = 0;
    for (const m of this.machines) {
      if (servesOf(m.kind) !== kind) continue;
      sum += m.util;
      n++;
    }
    return n > 0 ? sum / n : null;
  }

  // ---- セーブ/ロード ----

  serialize(): SaveData {
    const ids = (ls: Lot[]) => ls.map((l) => l.id);
    return {
      v: SAVE_VERSION,
      simTime: this.simTime,
      spawnInterval: this.spawnInterval,
      speed: this.speed,
      money: this.money,
      nextId,
      completedCount: this.completedCount,
      scrappedCount: this.scrappedCount,
      recentYields: this.recentYields,
      completions: this.completions,
      tpHistory: this.tpHistory,
      fleetSize: this.fleet.size,
      nodesUnlocked: [...this.nodesUnlocked],
      productsUnlocked: [...this.productsUnlocked],
      research: this.research,
      completedByProduct: this.completedByProduct,
      shippedByNode: this.shippedByNode,
      nodeCompleted: this.nodeCompleted,
      lots: this.lots.map((l) => ({
        id: l.id, product: l.product, step: l.step, y: l.yield_, gen: l.gen, expo: l.expoTier,
      })),
      machines: this.machines.map((m) => ({
        id: m.id, kind: m.kind, label: m.label,
        col: m.col, row: m.row, rot: m.rot,
        clean: m.cleanliness, util: m.util,
        pm: m.pm, pmLeft: m.pmLeft, jobs: m.jobs,
        busy: ids(m.busy), procLeft: m.procLeft,
        hold: ids(m.holdQueue), batch: ids(m.batch), batchTimer: m.batchTimer,
        storage: ids(m.storage),
        line: m.line ? { ...m.line } : null,
        ports: m.ports.map((p) => ({
          foup: p.foup ? p.foup.id : null, readyAt: p.readyAt,
        })),
      })),
      rail: this.rail.allEdges(),
      vehicles: this.fleet.vehicles.map((v) => ({
        tile: v.tile,
        state: v.state,
        carrying: v.carrying ? v.carrying.id : null,
        job: v.job
          ? {
              fm: v.job.from.machine.id, fp: v.job.from.machine.ports.indexOf(v.job.from),
              tm: v.job.to.machine.id, tp: v.job.to.machine.ports.indexOf(v.job.to),
            }
          : null,
      })),
    };
  }

  // 保存データから状態を復元(このインスタンスを作り直す)
  loadFrom(raw: SaveData | SaveDataV4 | SaveDataV2 | SaveDataV1): boolean {
    let data: SaveData | null = null;
    if (raw.v === SAVE_VERSION) {
      data = raw as SaveData;
    } else if (raw.v === 4 || raw.v === 3) {
      data = migrateV4(raw as SaveDataV4);
    } else if (raw.v === 2) {
      data = migrateV4(migrateV2(raw as SaveDataV2));
    } else if (raw.v === 1) {
      data = migrateV4(migrateV2(migrateV1(raw as SaveDataV1)));
    }
    if (!data) return false;
    // v4以前 → v5 でレシピ体系(露光ティア・配線層成長)が変わり、仕掛かりロットは破棄
    this.migrationNotice =
      raw.v < SAVE_VERSION && (raw as SaveDataV4).lots?.length > 0
        ? 'システム刷新に伴い、仕掛かり中のロットはリセットされました(工場・資金・研究進捗は維持)'
        : null;

    this.machines = [];
    this.lots = [];
    this.rail = new RailNetwork();
    this.fleet = new Fleet(this.rail);
    this.wireFleet();

    this.simTime = data.simTime;
    this.spawnInterval = data.spawnInterval;
    this.speed = data.speed;
    this.money = data.money ?? START_MONEY;
    this.completedCount = data.completedCount;
    this.scrappedCount = data.scrappedCount;
    this.recentYields =
      data.recentYields ?? data.completions.map((c) => c.y).slice(-YIELD_WINDOW);
    this.completions = data.completions;
    this.tpHistory = data.tpHistory;
    this.fleet.size = data.fleetSize;
    this.nodesUnlocked = new Set(data.nodesUnlocked?.length ? data.nodesUnlocked : [0]);
    this.productsUnlocked = new Set(data.productsUnlocked?.length ? data.productsUnlocked : ['diode']);
    this.research = data.research ?? null;
    this.completedByProduct = { ...zeroByProduct(), ...data.completedByProduct };
    this.shippedByNode = this.hydrateShipped(data.shippedByNode);
    this.nodeCompleted = this.hydrateNodeArr(data.nodeCompleted);
    this.waitSamples = [];

    const lotById = new Map<number, Lot>();
    for (const l of data.lots) {
      const lot: Lot = {
        id: l.id, product: l.product, step: l.step, yield_: l.y, gen: l.gen,
        expoTier: l.expo ?? singleLithoTier(l.gen),
      };
      this.lots.push(lot);
      lotById.set(l.id, lot);
    }
    const lot = (id: number | null) => (id === null ? null : lotById.get(id) ?? null);
    const lots = (idsArr: number[]) =>
      idsArr.map((id) => lotById.get(id)).filter((l): l is Lot => !!l);

    const machineById = new Map<number, Machine>();
    for (const md of data.machines) {
      const m = this.addMachine(md.kind, md.col, md.row, md.rot, true)!;
      m.id = md.id;
      m.label = md.label;
      m.cleanliness = md.clean;
      m.util = md.util ?? 0;
      m.pm = md.pm ?? false;
      m.pmLeft = md.pmLeft ?? 0;
      m.jobs = md.jobs;
      m.busy = lots(md.busy);
      m.procLeft = md.procLeft;
      m.holdQueue = lots(md.hold);
      m.batch = lots(md.batch);
      m.batchTimer = md.batchTimer;
      m.storage = lots(md.storage);
      if (m.kind === 'load') m.line = md.line ? { ...defaultLine(), ...md.line } : defaultLine();
      md.ports.forEach((ps, i) => {
        if (m.ports[i]) {
          m.ports[i].foup = lot(ps.foup);
          m.ports[i].readyAt = ps.readyAt;
        }
      });
      machineById.set(m.id, m);
    }

    for (const [a, b] of data.rail) this.rail.addEdge(a, b);

    for (const vd of data.vehicles) {
      let job: { from: Port; to: Port; lot: Lot } | null = null;
      if (vd.job) {
        const from = machineById.get(vd.job.fm)?.ports[vd.job.fp];
        const to = machineById.get(vd.job.tm)?.ports[vd.job.tp];
        const jobLot = lot(vd.carrying) ?? from?.foup ?? null;
        if (from && to && jobLot) job = { from, to, lot: jobLot };
      }
      const carrying = lot(vd.carrying);
      if (carrying && !job) {
        this.lots = this.lots.filter((l) => l !== carrying);
        this.fleet.restoreVehicle(vd.tile, vd.state, null, null);
        continue;
      }
      this.fleet.restoreVehicle(vd.tile, vd.state, carrying, job);
    }
    for (const v of this.fleet.vehicles) {
      if (!v.job) continue;
      if (!v.carrying) v.job.from.reserved = true;
      v.job.to.reserved = true;
    }

    nextId = data.nextId;
    return true;
  }

  private hydrateShipped(raw: Record<ProductId, number[]> | undefined): Record<ProductId, number[]> {
    const out = shippedInit();
    if (raw) {
      for (const id of PRODUCT_ORDER) {
        const arr = raw[id];
        if (arr) for (let g = 0; g <= MAX_GEN; g++) out[id][g] = arr[g] ?? 0;
      }
    }
    return out;
  }

  private hydrateNodeArr(raw: number[] | undefined): number[] {
    const out = nodeArray();
    if (raw) for (let g = 0; g <= MAX_GEN; g++) out[g] = raw[g] ?? 0;
    return out;
  }

  reset() {
    this.machines = [];
    this.lots = [];
    this.rail = new RailNetwork();
    this.fleet = new Fleet(this.rail);
    this.wireFleet();
    this.simTime = 0;
    this.money = START_MONEY;
    this.completions = [];
    this.completedCount = 0;
    this.scrappedCount = 0;
    this.recentYields = [];
    this.waitSamples = [];
    this.tpHistory = [];
    this.spawnInterval = DEFAULT_SPAWN_INTERVAL;
    this.nodesUnlocked = new Set([0]);
    this.productsUnlocked = new Set(['diode']);
    this.research = null;
    this.completedByProduct = zeroByProduct();
    this.shippedByNode = shippedInit();
    this.nodeCompleted = nodeArray();
    this.initStations();
  }
}

// ---- セーブデータ型 ----

export interface SaveData {
  v: number;
  simTime: number;
  spawnInterval: number;
  speed: number;
  money?: number;
  nextId: number;
  completedCount: number;
  scrappedCount: number;
  recentYields?: number[];
  completions: { t: number; y: number }[];
  tpHistory: number[];
  fleetSize: number;
  nodesUnlocked: number[];
  productsUnlocked: ProductId[];
  research: ResearchJob | null;
  completedByProduct: Record<ProductId, number>;
  shippedByNode: Record<ProductId, number[]>;
  nodeCompleted: number[];
  lots: { id: number; product: ProductId; step: number; y: number; gen: number; expo: number }[];
  machines: {
    id: number; kind: MachineKind; label: string;
    col: number; row: number; rot: number;
    clean: number; util?: number; pm: boolean; pmLeft: number; jobs: number;
    busy: number[]; procLeft: number; hold: number[];
    batch: number[]; batchTimer: number;
    storage: number[];
    line: LineConfig | null;
    ports: { foup: number | null; readyAt: number }[];
  }[];
  rail: [string, string][];
  vehicles: {
    tile: string;
    state: VehState;
    carrying: number | null;
    job: { fm: number; fp: number; tm: number; tp: number } | null;
  }[];
}

// v4以前(旧: 故障/手動修理・自動微細化・単一投入ミックス)のセーブ形式。
// machines は broken/repair を持ち、productGen/spawnWeights/unlocked を持つ
export interface SaveDataV4 {
  v: number;
  simTime: number;
  spawnInterval: number;
  speed: number;
  money?: number;
  nextId: number;
  completedCount: number;
  scrappedCount: number;
  recentYields?: number[];
  completions: { t: number; y: number }[];
  tpHistory: number[];
  fleetSize: number;
  unlocked: ProductId[];
  completedByProduct: Record<string, number>;
  productGen: Record<string, number>;
  spawnWeights: Record<string, number>;
  lots: { id: number; product: ProductId; step: number; y: number; gen: number }[];
  machines: {
    id: number; kind: string; label: string;
    col: number; row: number; rot: number;
    clean: number; util?: number; broken: boolean; repair: number; jobs: number;
    busy: number[]; procLeft: number; hold: number[];
    batch: number[]; batchTimer: number;
    storage: number[];
    ports: { foup: number | null; readyAt: number }[];
  }[];
  rail: [string, string][];
  vehicles: SaveData['vehicles'];
}

// v4 → v5: 工場レイアウト・資金・実績・レールは維持。到達済み世代までのノードを
// 研究済みに、旧解禁製品を研究済み製品に変換。故障系は撤去、旧露光機DUVはKrFへ
// 読み替える。レシピ体系が変わるため仕掛かりロットは全破棄
function migrateV4(old: SaveDataV4): SaveData {
  const kindRemap: Record<string, MachineKind> = { duv: 'krf' };
  const remap = (k: string): MachineKind => kindRemap[k] ?? (k as MachineKind);

  // 到達世代の最大値までのノードを研究済みに
  const maxGen = Math.max(0, ...Object.values(old.productGen ?? {}));
  const nodesUnlocked: number[] = [];
  for (let g = 0; g <= Math.min(maxGen, MAX_GEN); g++) nodesUnlocked.push(g);

  const productsUnlocked = (old.unlocked ?? ['diode']).filter(
    (id): id is ProductId => id in PRODUCTS,
  );
  if (!productsUnlocked.includes('diode')) productsUnlocked.push('diode');

  return {
    v: SAVE_VERSION,
    simTime: old.simTime,
    spawnInterval: old.spawnInterval,
    speed: old.speed,
    money: old.money,
    nextId: old.nextId,
    completedCount: old.completedCount,
    scrappedCount: old.scrappedCount,
    recentYields: old.recentYields,
    completions: old.completions,
    tpHistory: old.tpHistory,
    fleetSize: old.fleetSize,
    nodesUnlocked,
    productsUnlocked,
    research: null,
    completedByProduct: { ...zeroByProduct(), ...(old.completedByProduct as Record<ProductId, number>) },
    shippedByNode: shippedInit(),
    nodeCompleted: nodeArray(),
    lots: [],
    machines: old.machines.map((m) => ({
      id: m.id, kind: remap(m.kind), label: m.label,
      col: m.col, row: m.row, rot: m.rot,
      clean: m.clean, util: m.util, pm: false, pmLeft: 0, jobs: m.jobs,
      busy: [], procLeft: 0, hold: [], batch: [], batchTimer: 0, storage: [],
      line: remap(m.kind) === 'load' ? defaultLine() : null,
      ports: m.ports.map(() => ({ foup: null, readyAt: -1 })),
    })),
    rail: old.rail,
    vehicles: old.vehicles.map((v) => ({
      ...v, state: 'idle' as VehState, carrying: null, job: null,
    })),
  };
}

// v2(プロセスノード微細化の導入前): productGen 無し・ロットに gen 無し
export interface SaveDataV2 extends Omit<SaveDataV4, 'v' | 'productGen' | 'lots'> {
  v: number;
  lots: { id: number; product: ProductId; step: number; y: number }[];
}

function migrateV2(old: SaveDataV2): SaveDataV4 {
  const productGen: Record<string, number> = {};
  return {
    ...old,
    v: 4,
    productGen,
    lots: old.lots.map((l) => ({ ...l, gen: 0 })),
  };
}

// v1(製品システム導入前)のセーブデータ
export interface SaveDataV1 {
  v: number;
  simTime: number;
  spawnInterval: number;
  speed: number;
  nextId: number;
  completedCount: number;
  scrappedCount: number;
  completions: { t: number; y: number }[];
  tpHistory: number[];
  fleetSize: number;
  lots: { id: number; step: number; y: number }[];
  machines: (Omit<
    SaveDataV4['machines'][number],
    'busy' | 'hold' | 'batch' | 'batchTimer'
  > & { busy: number | null; hold: number | null })[];
  rail: [string, string][];
  vehicles: SaveData['vehicles'];
}

function migrateV1(old: SaveDataV1): SaveDataV2 {
  return {
    ...old,
    v: 2,
    unlocked: ['diode', 'logic'],
    completedByProduct: { logic: old.completedCount },
    spawnWeights: { logic: 1 },
    lots: old.lots.map((l) => ({ ...l, product: 'logic' as ProductId })),
    machines: old.machines.map((m) => ({
      ...m,
      busy: m.busy === null ? [] : [m.busy],
      hold: m.hold === null ? [] : [m.hold],
      batch: [],
      batchTimer: 0,
    })),
  };
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
