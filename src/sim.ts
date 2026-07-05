import {
  MAP_COLS, MAP_ROWS, MACHINE_DEFS, RECIPE, MAINT_TIME,
  MIN_CLEANLINESS, SCRAP_THRESHOLD, DEFAULT_SPAWN_INTERVAL, STOCKER_CAP,
} from './config';
import type { MachineKind } from './config';
import { RailNetwork, tkey } from './rail';
import { Fleet, portKey } from './oht';

export interface Lot {
  id: number;
  step: number;   // 次に受ける工程。RECIPE.length なら出荷待ち
  yield_: number; // 0..1
}

export interface Port {
  machine: Machine;
  col: number;      // 絶対タイル座標
  row: number;
  io: 'in' | 'out';
  foup: Lot | null;
  reserved: boolean; // in: 搬送予約済み / out: ビークル引き取り予約済み
}

export interface Machine {
  id: number;
  kind: MachineKind;
  label: string;   // 銘板表示(例: LITHO-2)
  col: number;
  row: number;
  busyLot: Lot | null;
  procLeft: number;
  holdLot: Lot | null;   // 処理完了したが出力ポートが塞がっていて出せないロット
  cleanliness: number;
  maintLeft: number;
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
  stepWip: number[];
  ohtTotal: number;
  ohtSize: number;
  ohtIdle: number;
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
  private completions: { t: number; y: number }[] = [];
  completedCount = 0;
  scrappedCount = 0;
  onMessage: (msg: string) => void = () => {};

  constructor() {
    this.addMachine('load', 2, 7, true);
    this.addMachine('ship', MAP_COLS - 4, 7, true);
  }

  // ---- 配置 ----

  footprintTiles(kind: MachineKind, col: number, row: number): { c: number; r: number }[] {
    const def = MACHINE_DEFS[kind];
    const tiles: { c: number; r: number }[] = [];
    for (let dc = 0; dc < def.w; dc++)
      for (let dr = 0; dr < def.h; dr++) tiles.push({ c: col + dc, r: row + dr });
    return tiles;
  }

  machineAtTile(c: number, r: number): Machine | undefined {
    return this.machines.find((m) => {
      const def = MACHINE_DEFS[m.kind];
      return c >= m.col && c < m.col + def.w && r >= m.row && r < m.row + def.h;
    });
  }

  canPlace(kind: MachineKind, col: number, row: number): boolean {
    return this.footprintTiles(kind, col, row).every(
      ({ c, r }) =>
        c >= 0 && r >= 0 && c < MAP_COLS && r < MAP_ROWS && !this.machineAtTile(c, r),
    );
  }

  addMachine(kind: MachineKind, col: number, row: number, force = false): Machine | null {
    if (!force && !this.canPlace(kind, col, row)) {
      this.onMessage('そこには設置できません');
      return null;
    }
    const def = MACHINE_DEFS[kind];
    const serial = this.machines.filter((x) => x.kind === kind).length + 1;
    const m: Machine = {
      id: nextId++, kind, label: `${def.short}-${serial}`, col, row,
      busyLot: null, procLeft: 0, holdLot: null,
      cleanliness: 1, maintLeft: 0, jobs: 0,
      ports: [], noRoute: false, storage: [],
    };
    m.ports = def.ports.map((p) => ({
      machine: m, col: col + p.dx, row: row + p.dy,
      io: p.io, foup: null, reserved: false,
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
    if (m.busyLot || m.maintLeft > 0) return false;
    m.maintLeft = MAINT_TIME;
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

        // 行き先候補: 空きin ポートを持つ装置(整備中は除く)。
        // 混雑度(処理中+出力待ち+in予約済み)が最小、同点なら距離
        let bestPort: Port | null = null;
        let bestScore = Infinity;
        for (const dest of this.machines) {
          if (dest.kind !== kind || dest.maintLeft > 0) continue;
          const inPort = dest.ports.find((x) => x.io === 'in' && !x.foup && !x.reserved);
          if (!inPort) continue;
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
            const dist = Math.hypot(inPort.col - p.col, inPort.row - p.row);
            if (dist < bestScore) {
              bestScore = dist;
              bestPort = inPort;
            }
          }
        }
        if (!bestPort) continue; // 空きが出るまで待つ

        // レール経路の確認(ピックアップ地点 → 降ろし地点)
        if (!this.rail.path(tkey(p.col, p.row), portKey(bestPort))) {
          m.noRoute = true;
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
      ohtTotal: this.fleet.vehicles.length,
      ohtSize: this.fleet.size,
      ohtIdle: this.fleet.idleCount(),
    };
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
