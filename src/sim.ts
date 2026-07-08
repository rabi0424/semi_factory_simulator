import {
  MAP_COLS, MAP_ROWS, MACHINE_DEFS, MAINT_TIME,
  MIN_CLEANLINESS, SCRAP_THRESHOLD, DEFAULT_SPAWN_INTERVAL, STOCKER_CAP,
  FURNACE_BATCH, FURNACE_WAIT,
  FAIL_BASE, FAIL_DIRTY_COEF, REPAIR_TIME, SAVE_VERSION,
  PRODUCTS, PRODUCT_ORDER, stepsOf,
  genFromCompleted, nodeLabel,
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
  step: number;   // 次に受ける工程。レシピ長なら出荷待ち
  yield_: number; // 0..1
  gen: number;    // 投入時のプロセス世代(このロットのレシピ段数を決める)
}

// 出力ポートに載ったFOUPが次工程へ搬送できず滞留している理由。
// 空きが出るのを待つだけの正常な滞留(全台が処理中)には付けない。
export interface StallInfo {
  kind: MachineKind;                      // 行き先として求めている装置種別
  reason: 'noroute' | 'missing' | 'down'; // 経路なし / 未設置 / 全台停止
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
  label: string;   // 銘板表示(例: LITHO-2)
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
  maintLeft: number;
  broken: boolean;       // 故障中
  repairLeft: number;    // >0 なら修理進行中
  jobs: number;
  ports: Port[];
  stall: StallInfo | null; // 出力FOUPが次工程へ搬送できず滞留している理由(無ければnull)
  storage: Lot[];        // ストッカーの内部保管棚
}

export interface Stats {
  wip: number;
  completed: number;
  scrapped: number;
  throughput: number;
  avgYield: number;
  avgWait: number;       // 平均搬送待ち [秒]
  ohtTotal: number;
  ohtSize: number;
  ohtIdle: number;
  broken: number;        // 故障中の装置数
}

let nextId = 1;

const zeroByProduct = (): Record<ProductId, number> =>
  ({ diode: 0, logic: 0, dram: 0, cpu: 0 });

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
  spawnInterval = DEFAULT_SPAWN_INTERVAL;
  private spawnTimer = 0;
  private dispatchTimer = 0;
  private histTimer = 0;
  private completions: { t: number; y: number }[] = [];
  completedCount = 0;
  scrappedCount = 0;
  yieldSum = 0; // 完成ロットの歩留まり累計(平均歩留まり用)
  // 製品システム
  unlocked = new Set<ProductId>(['diode']);
  completedByProduct = zeroByProduct();
  // 製品ごとの確定プロセス世代。新規投入ロットはこの世代のレシピで流れる
  productGen = zeroByProduct();
  spawnWeights: Record<ProductId, number> = { diode: 1, logic: 0, dram: 0, cpu: 0 };
  waitSamples: number[] = [];       // 搬送待ち時間の直近サンプル
  tpHistory: number[] = [];         // 5秒おきのスループット履歴(スパークライン用)
  onMessage: (msg: string) => void = () => {};

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
    this.addMachine('load', 2, 7, 0, true);
    this.addMachine('ship', MAP_COLS - 4, 7, 0, true);
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

  addMachine(
    kind: MachineKind, col: number, row: number, rot = 0, force = false,
  ): Machine | null {
    if (!force && !this.canPlace(kind, col, row, rot)) {
      this.onMessage('そこには設置できません');
      return null;
    }
    const def = MACHINE_DEFS[kind];
    const { w, h } = rotSize(def, rot);
    const serial = this.machines.filter((x) => x.kind === kind).length + 1;
    const m: Machine = {
      id: nextId++, kind, label: `${def.short}-${serial}`, col, row, rot, w, h,
      busy: [], procLeft: 0, holdQueue: [], batch: [], batchTimer: 0,
      cleanliness: 1, maintLeft: 0, broken: false, repairLeft: 0, jobs: 0,
      ports: [], stall: null, storage: [],
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
    if (!MACHINE_DEFS[m.kind].placeable) {
      this.onMessage('投入・出荷ステーションは撤去できません');
      return false;
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
    return true;
  }

  removeRailTile(c: number, r: number) {
    const k = tkey(c, r);
    if (this.fleet.isOccupied(k)) {
      this.onMessage('ビークルがいる区間は撤去できません');
      return;
    }
    this.rail.removeTile(k);
  }

  startMaintenance(m: Machine): boolean {
    if (m.busy.length > 0 || m.batch.length > 0 || m.maintLeft > 0 || m.broken) {
      return false;
    }
    m.maintLeft = MAINT_TIME;
    return true;
  }

  startRepair(m: Machine): boolean {
    if (!m.broken || m.repairLeft > 0) return false;
    m.repairLeft = REPAIR_TIME;
    return true;
  }

  // ---- 更新 ----

  update(rawDt: number) {
    if (this.paused) return;
    const dt = rawDt * this.speed;
    this.simTime += dt;

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

  private pickSpawnProduct(): ProductId | null {
    const pool: ProductId[] = [];
    for (const id of PRODUCT_ORDER) {
      if (!this.unlocked.has(id)) continue;
      for (let i = 0; i < (this.spawnWeights[id] ?? 0); i++) pool.push(id);
    }
    if (pool.length === 0) return null;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private updateSpawn(dt: number) {
    this.spawnTimer += dt;
    if (this.spawnTimer < this.spawnInterval) return;
    const load = this.machines.find((m) => m.kind === 'load');
    const port = load?.ports.find((p) => p.io === 'out' && !p.foup && !p.reserved);
    if (!port) return; // 払い出しポートが満杯なら待つ(自然なWIP制限)

    // WIPリリース制御(CONWIP): ストッカーが全て満杯の間は投入を止め、
    // 過飽和によるリエントラント・グリッドロックを防ぐ
    const stockers = this.machines.filter((m) => m.kind === 'stocker');
    if (
      stockers.length > 0 &&
      stockers.every((s) => s.storage.length >= STOCKER_CAP)
    ) {
      return;
    }

    const product = this.pickSpawnProduct();
    if (!product) return; // 投入比率がすべて0
    this.spawnTimer = 0;
    const lot: Lot = {
      id: nextId++, product, step: 0, yield_: 1, gen: this.productGen[product],
    };
    this.lots.push(lot);
    port.foup = lot;
    port.readyAt = this.simTime;
  }

  private checkUnlocks() {
    for (const id of PRODUCT_ORDER) {
      if (this.unlocked.has(id)) continue;
      if (this.completedCount >= PRODUCTS[id].unlockAt) {
        this.unlocked.add(id);
        this.spawnWeights[id] = 1;
        this.onMessage(
          `🎉 新製品「${PRODUCTS[id].name}」を解禁しました(${PRODUCTS[id].steps.length}工程)`,
        );
      }
    }
  }

  // 量産が進んだ製品のプロセス世代を微細化させる(以後の投入ロットに反映)
  private checkNodeShrink(id: ProductId) {
    const g = genFromCompleted(this.completedByProduct[id]);
    if (g <= this.productGen[id]) return;
    const from = this.productGen[id];
    this.productGen[id] = g;
    this.onMessage(
      `🔬 「${PRODUCTS[id].name}」がプロセス微細化 ${nodeLabel(from)}→${nodeLabel(g)}` +
      `(工程 ${stepsOf(id, from).length}→${stepsOf(id, g).length})`,
    );
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
          this.completedCount++;
          this.completedByProduct[done.product]++;
          this.yieldSum += done.yield_;
          this.completions.push({ t: this.simTime, y: done.yield_ });
          this.lots = this.lots.filter((l) => l !== done);
          p.foup = null;
          this.checkUnlocks();
          this.checkNodeShrink(done.product);
        }
      }
      return;
    }

    if (m.kind === 'stocker') {
      // 入力ポート → 内部棚、内部棚 → 空き出力ポート
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

    // 故障: 修理が始まっていれば進行、そうでなければ停止したまま
    if (m.broken) {
      if (m.repairLeft > 0) {
        m.repairLeft -= dt;
        if (m.repairLeft <= 0) {
          m.repairLeft = 0;
          m.broken = false;
          m.cleanliness = 1; // オーバーホール扱い
        }
      }
      return;
    }

    if (m.maintLeft > 0) {
      m.maintLeft -= dt;
      if (m.maintLeft <= 0) {
        m.maintLeft = 0;
        m.cleanliness = 1;
      }
      return;
    }

    this.flushHold(m);

    // 処理の進行
    if (m.busy.length > 0) {
      m.procLeft -= dt;
      if (m.procLeft <= 0) this.finishJob(m);
      return;
    }

    if (m.kind === 'furnace') {
      // バッチ装填: 入力ポートから炉内へ
      for (const p of m.ports) {
        if (p.io === 'in' && p.foup && m.batch.length < FURNACE_BATCH) {
          m.batch.push(p.foup);
          p.foup = null;
        }
      }
      if (m.batch.length === 0) {
        m.batchTimer = 0;
        return;
      }
      m.batchTimer += dt;
      // 満載になるか、待ち時間が上限に達したら処理開始。
      // 前バッチの搬出が済むまでは次を焼かない
      if (
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

  private finishJob(m: Machine) {
    const def = MACHINE_DEFS[m.kind];
    const lots = m.busy;
    m.busy = [];
    m.jobs++;

    // 汚れた装置ほど欠陥率が上がる。dirtiness は最大 1-MIN_CLEANLINESS(=0.8)
    // なので欠陥倍率は最大 1+0.8*4 = 約4.2倍
    const dirtiness = 1 - m.cleanliness;
    m.cleanliness = Math.max(MIN_CLEANLINESS, m.cleanliness - def.wear);

    for (const lot of lots) {
      const defect = def.baseDefect * (1 + dirtiness * 4) * rand(0.5, 1.5);
      lot.yield_ = Math.max(0, lot.yield_ * (1 - defect));
      lot.step++;

      // 最終工程(検査)完了 → 歩留まり確定。基準未満は廃棄
      if (lot.step >= stepsOf(lot.product, lot.gen).length && lot.yield_ < SCRAP_THRESHOLD) {
        this.scrappedCount++;
        this.lots = this.lots.filter((l) => l !== lot);
        continue;
      }
      m.holdQueue.push(lot);
    }

    // 故障判定(汚れているほど壊れやすい)
    if (Math.random() < FAIL_BASE + dirtiness * FAIL_DIRTY_COEF) {
      m.broken = true;
      this.onMessage(`⚠ ${m.label} が故障しました — 修理が必要です`);
    }
  }

  // 出力ポートのFOUPに搬送ジョブを割り当てる。
  // 工程が進んでいるロットを優先(下流から抜くとグリッドロックしにくい)
  private dispatch() {
    for (const m of this.machines) m.stall = null;

    const pending: { m: Machine; p: Port; progress: number }[] = [];
    for (const m of this.machines) {
      for (const p of m.ports) {
        if (p.io !== 'out' || !p.foup || p.reserved) continue;
        pending.push({
          m, p,
          progress: p.foup.step / stepsOf(p.foup.product, p.foup.gen).length,
        });
      }
    }
    pending.sort((a, b) => b.progress - a.progress);

    for (const { m, p } of pending) {
      {
        const lot = p.foup!;
        const steps = stepsOf(lot.product, lot.gen);
        const kind: MachineKind =
          lot.step >= steps.length ? 'ship' : steps[lot.step].kind;

        // このピックアップ地点からレールで到達できる範囲
        const reach = this.rail.reachableFrom(tkey(p.col, p.row));
        let sawUnreachable = false;
        let anyKind = false;        // その種類の装置が1台でも存在するか
        let anyOperational = false; // 稼働可能(非故障・非整備)な同種装置があるか

        // 行き先候補: 空きin ポートを持ち、レール経路が通っている装置
        // (整備・故障中は除く)。混雑度が最小、同点なら距離
        let bestPort: Port | null = null;
        let bestScore = Infinity;
        for (const dest of this.machines) {
          if (dest.kind !== kind) continue;
          anyKind = true;
          if (dest.maintLeft > 0 || dest.broken) continue;
          anyOperational = true;
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

        // 行き先が満杯なら、ストッカーへ退避(リエントラントフローの
        // デッドロック回避)。ストッカー発のロットは実行き先が空くまで待つ
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
          // 空きが出るまで待つ。滞留がプレイヤーの見落とし由来なら警告する:
          //  - noroute: 装置はあるがレールが繋がっていない
          //  - missing: その種類の装置を一台も置いていない
          //  - down   : 同種装置はあるが全台が故障/整備中
          // 「全台が処理中で満杯」なだけの正常な滞留には警告を出さない
          if (sawUnreachable) m.stall = { kind, reason: 'noroute' };
          else if (!anyKind) m.stall = { kind, reason: 'missing' };
          else if (!anyOperational) m.stall = { kind, reason: 'down' };
          continue;
        }
        if (this.fleet.tryAssign({ from: p, to: bestPort, lot })) {
          p.reserved = true;
          bestPort.reserved = true;
        }
      }
    }
  }

  getStats(): Stats {
    const throughput = this.currentThroughput();
    const avgYield = this.completedCount > 0 ? this.yieldSum / this.completedCount : 0;
    const avgWait =
      this.waitSamples.length > 0
        ? this.waitSamples.reduce((s, w) => s + w, 0) / this.waitSamples.length
        : 0;
    return {
      wip: this.lots.length,
      completed: this.completedCount,
      scrapped: this.scrappedCount,
      throughput,
      avgYield,
      avgWait,
      ohtTotal: this.fleet.vehicles.length,
      ohtSize: this.fleet.size,
      ohtIdle: this.fleet.idleCount(),
      broken: this.machines.filter((m) => m.broken).length,
    };
  }

  // 製品×世代の工程別仕掛かり(フローパネル用)。表示世代のロットのみ数える
  stepWipOf(product: ProductId, gen: number): number[] {
    const wip = stepsOf(product, gen).map(() => 0);
    for (const lot of this.lots) {
      if (lot.product === product && lot.gen === gen && lot.step < wip.length) {
        wip[lot.step]++;
      }
    }
    return wip;
  }

  // 表示世代と異なる世代で流れている同製品ロット数(移行期の残存分)
  otherGenWipOf(product: ProductId, gen: number): number {
    let n = 0;
    for (const lot of this.lots) {
      if (lot.product === product && lot.gen !== gen) n++;
    }
    return n;
  }

  // ---- セーブ/ロード ----

  serialize(): SaveData {
    const ids = (ls: Lot[]) => ls.map((l) => l.id);
    return {
      v: SAVE_VERSION,
      simTime: this.simTime,
      spawnInterval: this.spawnInterval,
      speed: this.speed,
      nextId,
      completedCount: this.completedCount,
      scrappedCount: this.scrappedCount,
      yieldSum: this.yieldSum,
      completions: this.completions,
      tpHistory: this.tpHistory,
      fleetSize: this.fleet.size,
      unlocked: [...this.unlocked],
      completedByProduct: this.completedByProduct,
      productGen: this.productGen,
      spawnWeights: this.spawnWeights,
      lots: this.lots.map((l) => ({
        id: l.id, product: l.product, step: l.step, y: l.yield_, gen: l.gen,
      })),
      machines: this.machines.map((m) => ({
        id: m.id, kind: m.kind, label: m.label,
        col: m.col, row: m.row, rot: m.rot,
        clean: m.cleanliness, maint: m.maintLeft,
        broken: m.broken, repair: m.repairLeft, jobs: m.jobs,
        busy: ids(m.busy), procLeft: m.procLeft,
        hold: ids(m.holdQueue), batch: ids(m.batch), batchTimer: m.batchTimer,
        storage: ids(m.storage),
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
  loadFrom(raw: SaveData | SaveDataV2 | SaveDataV1): boolean {
    const data: SaveData | null =
      raw.v === SAVE_VERSION ? (raw as SaveData)
      : raw.v === 2 ? migrateV2(raw as SaveDataV2)
      : raw.v === 1 ? migrateV2(migrateV1(raw as SaveDataV1))
      : null;
    if (!data) return false;

    this.machines = [];
    this.lots = [];
    this.rail = new RailNetwork();
    this.fleet = new Fleet(this.rail);
    this.wireFleet();

    this.simTime = data.simTime;
    this.spawnInterval = data.spawnInterval;
    this.speed = data.speed;
    this.completedCount = data.completedCount;
    this.scrappedCount = data.scrappedCount;
    // 旧データ(yieldSum無し)は直近の完成実績から概算
    this.yieldSum =
      data.yieldSum ??
      (data.completions.length > 0
        ? (data.completions.reduce((s, c) => s + c.y, 0) / data.completions.length) *
          data.completedCount
        : 0);
    this.completions = data.completions;
    this.tpHistory = data.tpHistory;
    this.fleet.size = data.fleetSize;
    this.unlocked = new Set(data.unlocked);
    this.completedByProduct = { ...zeroByProduct(), ...data.completedByProduct };
    this.productGen = { ...zeroByProduct(), ...data.productGen };
    this.spawnWeights = { ...zeroByProduct(), ...data.spawnWeights };
    this.spawnTimer = 0;
    this.waitSamples = [];

    const lotById = new Map<number, Lot>();
    for (const l of data.lots) {
      const lot: Lot = {
        id: l.id, product: l.product, step: l.step, yield_: l.y, gen: l.gen,
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
      m.maintLeft = md.maint;
      m.broken = md.broken;
      m.repairLeft = md.repair;
      m.jobs = md.jobs;
      m.busy = lots(md.busy);
      m.procLeft = md.procLeft;
      m.holdQueue = lots(md.hold);
      m.batch = lots(md.batch);
      m.batchTimer = md.batchTimer;
      m.storage = lots(md.storage);
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
        // ジョブを復元できない運搬中ロットは孤児になるため破棄
        this.lots = this.lots.filter((l) => l !== carrying);
        this.fleet.restoreVehicle(vd.tile, vd.state, null, null);
        continue;
      }
      this.fleet.restoreVehicle(vd.tile, vd.state, carrying, job);
    }
    // 予約フラグはビークルのジョブから再構築
    for (const v of this.fleet.vehicles) {
      if (!v.job) continue;
      if (!v.carrying) v.job.from.reserved = true;
      v.job.to.reserved = true;
    }

    nextId = data.nextId;
    return true;
  }

  reset() {
    this.machines = [];
    this.lots = [];
    this.rail = new RailNetwork();
    this.fleet = new Fleet(this.rail);
    this.wireFleet();
    this.simTime = 0;
    this.spawnTimer = 0;
    this.completions = [];
    this.completedCount = 0;
    this.scrappedCount = 0;
    this.yieldSum = 0;
    this.waitSamples = [];
    this.tpHistory = [];
    this.spawnInterval = DEFAULT_SPAWN_INTERVAL;
    this.unlocked = new Set(['diode']);
    this.completedByProduct = zeroByProduct();
    this.productGen = zeroByProduct();
    this.spawnWeights = { diode: 1, logic: 0, dram: 0, cpu: 0 };
    this.initStations();
  }
}

// ---- セーブデータ型 ----

export interface SaveData {
  v: number;
  simTime: number;
  spawnInterval: number;
  speed: number;
  nextId: number;
  completedCount: number;
  scrappedCount: number;
  yieldSum?: number; // v2初期のセーブには無い
  completions: { t: number; y: number }[];
  tpHistory: number[];
  fleetSize: number;
  unlocked: ProductId[];
  completedByProduct: Record<ProductId, number>;
  productGen: Record<ProductId, number>;
  spawnWeights: Record<ProductId, number>;
  lots: { id: number; product: ProductId; step: number; y: number; gen: number }[];
  machines: {
    id: number; kind: MachineKind; label: string;
    col: number; row: number; rot: number;
    clean: number; maint: number; broken: boolean; repair: number; jobs: number;
    busy: number[]; procLeft: number; hold: number[];
    batch: number[]; batchTimer: number;
    storage: number[];
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

// v2(プロセスノード微細化の導入前): productGen 無し・ロットに gen 無し
export interface SaveDataV2 extends Omit<SaveData, 'v' | 'productGen' | 'lots'> {
  v: number;
  lots: { id: number; product: ProductId; step: number; y: number }[];
}

// v2 → v3: 既に稼いだ量産数から各製品の到達世代を復元。既存の仕掛かりロットは
// 投入時世代が不明なため基本レシピ(gen 0)として流し切る
function migrateV2(old: SaveDataV2): SaveData {
  const completed = { ...zeroByProduct(), ...old.completedByProduct };
  const productGen = zeroByProduct();
  for (const id of PRODUCT_ORDER) productGen[id] = genFromCompleted(completed[id]);
  return {
    ...old,
    v: SAVE_VERSION,
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
    SaveData['machines'][number],
    'busy' | 'hold' | 'batch' | 'batchTimer'
  > & { busy: number | null; hold: number | null })[];
  rail: [string, string][];
  vehicles: SaveData['vehicles'];
}

// v1のロットはすべて旧レシピ(ロジックIC)として扱う。v2形に変換し、
// 続けて migrateV2 で現行版へ引き上げる
function migrateV1(old: SaveDataV1): SaveDataV2 {
  return {
    ...old,
    v: 2,
    unlocked: ['diode', 'logic'],
    completedByProduct: { diode: 0, logic: old.completedCount, dram: 0, cpu: 0 },
    spawnWeights: { diode: 0, logic: 1, dram: 0, cpu: 0 },
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
