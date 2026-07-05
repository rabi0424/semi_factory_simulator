import {
  MAP_COLS, MAP_ROWS, MACHINE_DEFS, RECIPE, MAINT_TIME,
  MIN_CLEANLINESS, SCRAP_THRESHOLD, DEFAULT_SPAWN_INTERVAL, STOCKER_CAP,
  FAIL_BASE, FAIL_DIRTY_COEF, REPAIR_TIME, SAVE_VERSION,
  rotSize, rotPorts,
} from './config';
import type { MachineKind } from './config';
import { RailNetwork, tkey } from './rail';
import { Fleet, portKey } from './oht';
import type { VehState } from './oht';

export interface Lot {
  id: number;
  step: number;   // 次に受ける工程。RECIPE.length なら出荷待ち
  yield_: number; // 0..1
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
  busyLot: Lot | null;
  procLeft: number;
  holdLot: Lot | null;   // 処理完了したが出力ポートが塞がっていて出せないロット
  cleanliness: number;
  maintLeft: number;
  broken: boolean;       // 故障中
  repairLeft: number;    // >0 なら修理進行中
  jobs: number;
  ports: Port[];
  noRoute: boolean;      // 次工程へのレール経路がない
  storage: Lot[];        // ストッカーの内部保管棚
}

export interface Stats {
  wip: number;
  completed: number;
  scrapped: number;
  throughput: number;
  avgYield: number;
  avgWait: number;       // 平均搬送待ち [秒]
  stepWip: number[];
  ohtTotal: number;
  ohtSize: number;
  ohtIdle: number;
  broken: number;        // 故障中の装置数
}

let nextId = 1;

export class Game {
  machines: Machine[] = [];
  lots: Lot[] = [];
  rail = new RailNetwork();
  fleet = new Fleet(this.rail);
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
      busyLot: null, procLeft: 0, holdLot: null,
      cleanliness: 1, maintLeft: 0, broken: false, repairLeft: 0, jobs: 0,
      ports: [], noRoute: false, storage: [],
    };
    m.ports = rotPorts(def, rot).map((p) => ({
      machine: m, col: col + p.dx, row: row + p.dy,
      fx: p.fx, fy: p.fy,
      io: p.io, foup: null, reserved: false, readyAt: -1,
    }));
    this.machines.push(m);
    return m;
  }

  removeMachine(m: Machine): boolean {
    if (!MACHINE_DEFS[m.kind].placeable) {
      this.onMessage('投入・出荷ステーションは撤去できません');
      return false;
    }
    if (
      m.busyLot || m.holdLot || m.storage.length > 0 ||
      m.ports.some((p) => p.foup || p.reserved)
    ) {
      this.onMessage('ロットが残っている装置は撤去できません');
      return false;
    }
    this.machines = this.machines.filter((x) => x !== m);
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
    if (m.busyLot || m.maintLeft > 0 || m.broken) return false;
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
    this.fleet.update(dt);

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

  private updateSpawn(dt: number) {
    this.spawnTimer += dt;
    if (this.spawnTimer < this.spawnInterval) return;
    const load = this.machines.find((m) => m.kind === 'load');
    const port = load?.ports.find((p) => p.io === 'out' && !p.foup && !p.reserved);
    if (!port) return; // 払い出しポートが満杯なら待つ(自然なWIP制限)
    this.spawnTimer = 0;
    const lot: Lot = { id: nextId++, step: 0, yield_: 1 };
    this.lots.push(lot);
    port.foup = lot;
    port.readyAt = this.simTime;
  }

  private updateMachine(m: Machine, dt: number) {
    if (m.kind === 'load') return;

    if (m.kind === 'ship') {
      for (const p of m.ports) {
        if (p.foup) {
          this.completedCount++;
          this.completions.push({ t: this.simTime, y: p.foup.yield_ });
          this.lots = this.lots.filter((l) => l !== p.foup);
          p.foup = null;
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

    // 出力待ちロットを空いた出力ポートへ
    if (m.holdLot) {
      const out = m.ports.find((p) => p.io === 'out' && !p.foup);
      if (out) {
        out.foup = m.holdLot;
        out.readyAt = this.simTime;
        m.holdLot = null;
      }
    }

    if (m.busyLot) {
      m.procLeft -= dt;
      if (m.procLeft <= 0) this.finishJob(m);
      return;
    }

    // 出力が詰まっている間は次の処理を始めない
    if (m.holdLot) return;

    const inPort = m.ports.find((p) => p.io === 'in' && p.foup);
    if (inPort) {
      m.busyLot = inPort.foup;
      inPort.foup = null;
      m.procLeft = MACHINE_DEFS[m.kind].procTime;
    }
  }

  private finishJob(m: Machine) {
    const lot = m.busyLot!;
    m.busyLot = null;
    m.jobs++;
    const def = MACHINE_DEFS[m.kind];

    // 汚れた装置ほど欠陥率が上がる(清浄度が下がると最大5倍)
    const dirtiness = 1 - m.cleanliness;
    const defect = def.baseDefect * (1 + dirtiness * 4) * rand(0.5, 1.5);
    lot.yield_ = Math.max(0, lot.yield_ * (1 - defect));
    m.cleanliness = Math.max(MIN_CLEANLINESS, m.cleanliness - def.wear);

    lot.step++;

    // 故障判定(汚れているほど壊れやすい)
    if (Math.random() < FAIL_BASE + dirtiness * FAIL_DIRTY_COEF) {
      m.broken = true;
      this.onMessage(`⚠ ${m.label} が故障しました — 修理が必要です`);
    }

    // 最終工程(検査)完了 → 歩留まり確定。基準未満は廃棄
    if (lot.step >= RECIPE.length && lot.yield_ < SCRAP_THRESHOLD) {
      this.scrappedCount++;
      this.lots = this.lots.filter((l) => l !== lot);
      return;
    }
    m.holdLot = lot;
  }

  // 出力ポートのFOUPに搬送ジョブを割り当てる
  private dispatch() {
    for (const m of this.machines) m.noRoute = false;

    for (const m of this.machines) {
      for (const p of m.ports) {
        if (p.io !== 'out' || !p.foup || p.reserved) continue;
        const lot = p.foup;
        const kind: MachineKind =
          lot.step >= RECIPE.length ? 'ship' : RECIPE[lot.step].kind;

        // このピックアップ地点からレールで到達できる範囲
        const reach = this.rail.reachableFrom(tkey(p.col, p.row));
        let sawUnreachable = false;

        // 行き先候補: 空きin ポートを持ち、レール経路が通っている装置
        // (整備・故障中は除く)。混雑度が最小、同点なら距離
        let bestPort: Port | null = null;
        let bestScore = Infinity;
        for (const dest of this.machines) {
          if (dest.kind !== kind || dest.maintLeft > 0 || dest.broken) continue;
          const inPort = dest.ports.find((x) => x.io === 'in' && !x.foup && !x.reserved);
          if (!inPort) continue;
          if (!reach.has(portKey(inPort))) {
            sawUnreachable = true;
            continue;
          }
          const load =
            (dest.busyLot ? 1 : 0) + (dest.holdLot ? 1 : 0) +
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
          // 空きが出るまで待つ。レールが繋がっていない行き先しか
          // なかった場合は警告を出す
          if (sawUnreachable) m.noRoute = true;
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
    const avgYield =
      this.completions.length > 0
        ? this.completions.reduce((s, c) => s + c.y, 0) / this.completions.length
        : 0;
    const avgWait =
      this.waitSamples.length > 0
        ? this.waitSamples.reduce((s, w) => s + w, 0) / this.waitSamples.length
        : 0;
    const stepWip = RECIPE.map(() => 0);
    for (const lot of this.lots) {
      if (lot.step < RECIPE.length) stepWip[lot.step]++;
    }
    return {
      wip: this.lots.length,
      completed: this.completedCount,
      scrapped: this.scrappedCount,
      throughput,
      avgYield,
      avgWait,
      stepWip,
      ohtTotal: this.fleet.vehicles.length,
      ohtSize: this.fleet.size,
      ohtIdle: this.fleet.idleCount(),
      broken: this.machines.filter((m) => m.broken).length,
    };
  }

  // ---- セーブ/ロード ----

  serialize(): SaveData {
    const lotId = (l: Lot | null) => (l ? l.id : null);
    return {
      v: SAVE_VERSION,
      simTime: this.simTime,
      spawnInterval: this.spawnInterval,
      speed: this.speed,
      nextId,
      completedCount: this.completedCount,
      scrappedCount: this.scrappedCount,
      completions: this.completions,
      tpHistory: this.tpHistory,
      fleetSize: this.fleet.size,
      lots: this.lots.map((l) => ({ id: l.id, step: l.step, y: l.yield_ })),
      machines: this.machines.map((m) => ({
        id: m.id, kind: m.kind, label: m.label,
        col: m.col, row: m.row, rot: m.rot,
        clean: m.cleanliness, maint: m.maintLeft,
        broken: m.broken, repair: m.repairLeft, jobs: m.jobs,
        busy: lotId(m.busyLot), procLeft: m.procLeft, hold: lotId(m.holdLot),
        storage: m.storage.map((l) => l.id),
        ports: m.ports.map((p) => ({ foup: lotId(p.foup), readyAt: p.readyAt })),
      })),
      rail: this.rail.allEdges(),
      vehicles: this.fleet.vehicles.map((v) => ({
        tile: v.tile,
        state: v.state,
        carrying: lotId(v.carrying),
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
  loadFrom(data: SaveData): boolean {
    if (data.v !== SAVE_VERSION) return false;

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
    this.completions = data.completions;
    this.tpHistory = data.tpHistory;
    this.fleet.size = data.fleetSize;
    this.spawnTimer = 0;
    this.waitSamples = [];

    const lotById = new Map<number, Lot>();
    for (const l of data.lots) {
      const lot: Lot = { id: l.id, step: l.step, yield_: l.y };
      this.lots.push(lot);
      lotById.set(l.id, lot);
    }
    const lot = (id: number | null) => (id === null ? null : lotById.get(id) ?? null);

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
      m.busyLot = lot(md.busy);
      m.procLeft = md.procLeft;
      m.holdLot = lot(md.hold);
      m.storage = md.storage.map((id) => lot(id)!).filter(Boolean);
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
    this.waitSamples = [];
    this.tpHistory = [];
    this.spawnInterval = DEFAULT_SPAWN_INTERVAL;
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
  completions: { t: number; y: number }[];
  tpHistory: number[];
  fleetSize: number;
  lots: { id: number; step: number; y: number }[];
  machines: {
    id: number; kind: MachineKind; label: string;
    col: number; row: number; rot: number;
    clean: number; maint: number; broken: boolean; repair: number; jobs: number;
    busy: number | null; procLeft: number; hold: number | null;
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

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
