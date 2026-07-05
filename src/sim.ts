import {
  COLS, ROWS, TILE, MACHINE_DEFS, RECIPE, QUEUE_CAP, MAINT_TIME,
  MIN_CLEANLINESS, SCRAP_THRESHOLD, LOT_SPEED, WIP_CAP,
  DEFAULT_SPAWN_INTERVAL,
} from './config';
import type { MachineKind } from './config';

export type LotState = 'waiting' | 'moving' | 'queued' | 'processing';

export interface Lot {
  id: number;
  x: number;
  y: number;
  step: number;          // 次に受ける工程のインデックス。RECIPE.length なら出荷待ち
  yield_: number;        // 0..1
  state: LotState;
  target: Machine | null;
  jitterX: number;       // 待機時の表示オフセット
  jitterY: number;
}

export interface Machine {
  id: number;
  kind: MachineKind;
  col: number;
  row: number;
  busyLot: Lot | null;
  procLeft: number;
  cleanliness: number;   // 0.2..1.0
  maintLeft: number;     // >0 ならメンテナンス中
  jobs: number;
  queue: Lot[];          // 予約済みロット(移動中も含む)
  arrived: Set<Lot>;     // queue のうち到着済みのもの
}

export interface Stats {
  wip: number;
  completed: number;
  scrapped: number;
  throughput: number;    // 直近60秒のロット/分
  avgYield: number;      // 完成ロットの平均歩留まり
  stepWip: number[];     // 工程ごとの仕掛かり数(ボトルネック可視化用)
}

let nextId = 1;

export class Game {
  machines: Machine[] = [];
  lots: Lot[] = [];
  simTime = 0;
  paused = false;
  speed = 1;
  spawnInterval = DEFAULT_SPAWN_INTERVAL;
  private spawnTimer = 0;
  private completions: { t: number; y: number }[] = [];
  completedCount = 0;
  scrappedCount = 0;
  onMessage: (msg: string) => void = () => {};

  constructor() {
    // 投入口と出荷口は最初から設置済み
    this.addMachine('load', 0, Math.floor(ROWS / 2));
    this.addMachine('ship', COLS - 1, Math.floor(ROWS / 2));
  }

  machineAt(col: number, row: number): Machine | undefined {
    return this.machines.find((m) => m.col === col && m.row === row);
  }

  addMachine(kind: MachineKind, col: number, row: number): Machine | null {
    if (col < 0 || row < 0 || col >= COLS || row >= ROWS) return null;
    if (this.machineAt(col, row)) {
      this.onMessage('そのマスには既に装置があります');
      return null;
    }
    const m: Machine = {
      id: nextId++, kind, col, row,
      busyLot: null, procLeft: 0,
      cleanliness: 1, maintLeft: 0, jobs: 0,
      queue: [], arrived: new Set(),
    };
    this.machines.push(m);
    return m;
  }

  removeMachine(m: Machine): boolean {
    if (!MACHINE_DEFS[m.kind].placeable) {
      this.onMessage('投入口・出荷口は撤去できません');
      return false;
    }
    if (m.busyLot || m.queue.length > 0) {
      this.onMessage('処理中・待機中のロットがあるため撤去できません');
      return false;
    }
    this.machines = this.machines.filter((x) => x !== m);
    return true;
  }

  startMaintenance(m: Machine): boolean {
    if (m.busyLot || m.maintLeft > 0) return false;
    m.maintLeft = MAINT_TIME;
    return true;
  }

  update(rawDt: number) {
    if (this.paused) return;
    const dt = rawDt * this.speed;
    this.simTime += dt;

    this.updateSpawn(dt);
    for (const m of this.machines) this.updateMachine(m, dt);
    for (const lot of [...this.lots]) this.updateLot(lot, dt);
  }

  private updateSpawn(dt: number) {
    this.spawnTimer += dt;
    if (this.spawnTimer < this.spawnInterval) return;
    if (this.lots.length >= WIP_CAP) return; // 上限に達したら待つ(タイマーは満杯のまま)
    this.spawnTimer = 0;
    const load = this.machines.find((m) => m.kind === 'load');
    if (!load) return;
    const { x, y } = centerOf(load);
    this.lots.push({
      id: nextId++, x, y,
      step: 0, yield_: 1, state: 'waiting', target: null,
      jitterX: rand(-14, 14), jitterY: rand(-14, 14),
    });
  }

  private updateMachine(m: Machine, dt: number) {
    if (m.maintLeft > 0) {
      m.maintLeft -= dt;
      if (m.maintLeft <= 0) {
        m.maintLeft = 0;
        m.cleanliness = 1;
      }
      return;
    }

    // 処理の進行
    if (m.busyLot) {
      m.procLeft -= dt;
      if (m.procLeft <= 0) this.finishJob(m);
      return;
    }

    // 到着済みロットの処理開始
    const next = m.queue.find((l) => m.arrived.has(l));
    if (next) {
      m.queue = m.queue.filter((l) => l !== next);
      m.arrived.delete(next);
      m.busyLot = next;
      m.procLeft = MACHINE_DEFS[m.kind].procTime;
      next.state = 'processing';
      const c = centerOf(m);
      next.x = c.x;
      next.y = c.y;
    }
  }

  private finishJob(m: Machine) {
    const lot = m.busyLot!;
    m.busyLot = null;
    m.jobs++;
    const def = MACHINE_DEFS[m.kind];

    // 汚れた装置ほど欠陥率が上がる(清浄度50%で基礎欠陥率の3倍)
    const dirtiness = 1 - m.cleanliness;
    const defect = def.baseDefect * (1 + dirtiness * 4) * rand(0.5, 1.5);
    lot.yield_ = Math.max(0, lot.yield_ * (1 - defect));
    m.cleanliness = Math.max(MIN_CLEANLINESS, m.cleanliness - def.wear);

    lot.step++;
    lot.jitterX = rand(-14, 14);
    lot.jitterY = rand(-14, 14);

    // 検査(最終工程)完了 → 歩留まり確定。低すぎれば廃棄
    if (lot.step >= RECIPE.length && lot.yield_ < SCRAP_THRESHOLD) {
      this.scrappedCount++;
      this.lots = this.lots.filter((l) => l !== lot);
      return;
    }
    lot.state = 'waiting';
    lot.target = null;
  }

  private updateLot(lot: Lot, dt: number) {
    if (lot.state === 'waiting') {
      this.dispatch(lot);
      return;
    }
    if (lot.state !== 'moving' || !lot.target) return;

    const { x: tx, y: ty } = centerOf(lot.target);
    const dx = tx - lot.x;
    const dy = ty - lot.y;
    const dist = Math.hypot(dx, dy);
    const stepDist = LOT_SPEED * dt;
    if (dist <= stepDist) {
      lot.x = tx;
      lot.y = ty;
      this.arrive(lot, lot.target);
    } else {
      lot.x += (dx / dist) * stepDist;
      lot.y += (dy / dist) * stepDist;
    }
  }

  private arrive(lot: Lot, m: Machine) {
    if (m.kind === 'ship') {
      this.completedCount++;
      this.completions.push({ t: this.simTime, y: lot.yield_ });
      this.lots = this.lots.filter((l) => l !== lot);
      return;
    }
    lot.state = 'queued';
    m.arrived.add(lot);
  }

  // 次工程を担当できる装置を探してロットを送り出す
  private dispatch(lot: Lot) {
    const kind: MachineKind =
      lot.step >= RECIPE.length ? 'ship' : RECIPE[lot.step].kind;
    const cap = kind === 'ship' ? Infinity : QUEUE_CAP;

    let best: Machine | null = null;
    let bestScore = Infinity;
    for (const m of this.machines) {
      if (m.kind !== kind) continue;
      if (m.maintLeft > 0) continue;
      if (m.queue.length >= cap) continue;
      const c = centerOf(m);
      // 待ち行列の短さを最優先、同数なら近い装置
      const score = m.queue.length * 100000 + Math.hypot(c.x - lot.x, c.y - lot.y);
      if (score < bestScore) {
        bestScore = score;
        best = m;
      }
    }
    if (!best) return; // 行き先がない間はその場で待機

    best.queue.push(lot);
    lot.target = best;
    lot.state = 'moving';
  }

  getStats(): Stats {
    const horizon = 60;
    const from = this.simTime - horizon;
    this.completions = this.completions.filter((c) => c.t >= from);
    const window = Math.min(horizon, Math.max(this.simTime, 1));
    const throughput = (this.completions.length / window) * 60;
    const avgYield =
      this.completions.length > 0
        ? this.completions.reduce((s, c) => s + c.y, 0) / this.completions.length
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
      stepWip,
    };
  }
}

export function centerOf(m: Machine): { x: number; y: number } {
  return { x: (m.col + 0.5) * TILE, y: (m.row + 0.5) * TILE };
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
