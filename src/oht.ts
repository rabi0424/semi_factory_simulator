// OHT(天井走行搬送)ビークルの運行管理。
// ビークルは搬送ジョブに応じて自動で稼働するが、保有台数(size)までしか増えない。

import {
  TILE, OHT_SPEED, OHT_IDLE_SPEED, HOIST_TIME, START_FLEET,
  OHT_ACCEL_TILES, OHT_MIN_SPEED_FACTOR,
  HEAT_ROUTE_WEIGHT, HEAT_ROUTE_CLAMP,
} from './config';
import { RailNetwork, tkey, parseKey } from './rail';
import type { TileKey } from './rail';
import type { Lot, Port } from './sim';

export interface TransportJob {
  from: Port;
  to: Port;
  lot: Lot;
}

export type VehState =
  | 'idle'
  | 'toPickup' | 'pickDown' | 'pickUp'
  | 'toDrop'   | 'dropDown' | 'dropUp';

let vehId = 1;

export class Vehicle {
  id = vehId++;
  tile: TileKey;
  target: TileKey | null = null;
  progress = 0;          // 現在エッジ上の進捗 0..1
  path: TileKey[] = [];  // これから通るタイル列(tile の次から)
  state: VehState = 'idle';
  hoistT = 0;            // ホイスト降下量 0(天井)..1(床)
  carrying: Lot | null = null;
  job: TransportJob | null = null;
  stuck = false;         // 経路喪失などで停止中
  retryTimer = 0;

  // 現在の走行区間(発車〜到着)の長さ[タイル]と、発車からの累計距離。
  // 加減速の位置(区間の何タイル目か)を判定するために使う
  journeyLen = 1;
  journeyPos = 0;

  constructor(tile: TileKey) {
    this.tile = tile;
  }
}

export function portKey(p: Port): TileKey {
  return tkey(p.col, p.row);
}

// 発車直後・到着直前のOHT_ACCEL_TILES区間だけ速度を落とす(S字カーブ)。
// pos: 発車地点からの累計距離[タイル] / len: ジャーニー全長[タイル]
function speedFactor(pos: number, len: number): number {
  const distFromStart = pos;
  const distToEnd = len - pos;
  const raw = Math.min(1, distFromStart / OHT_ACCEL_TILES, distToEnd / OHT_ACCEL_TILES);
  const eased = raw * raw * (3 - 2 * raw); // smoothstep
  return Math.max(OHT_MIN_SPEED_FACTOR, eased);
}

export function vehiclePos(v: Vehicle): { x: number; y: number } {
  const a = parseKey(v.tile);
  let x = (a.c + 0.5) * TILE;
  let y = (a.r + 0.5) * TILE;
  if (v.target) {
    const b = parseKey(v.target);
    x += (b.c - a.c) * TILE * v.progress;
    y += (b.r - a.r) * TILE * v.progress;
  }
  return { x, y };
}

export class Fleet {
  vehicles: Vehicle[] = [];
  size = START_FLEET;    // 保有台数(この数までしか湧かない)
  private occ = new Map<TileKey, Vehicle>();

  // FOUPを吊り上げた瞬間に呼ばれる(搬送待ち統計用)
  onPickup: (port: Port) => void = () => {};

  // 渋滞ヒート: タイルごとの「待たされた時間」の蓄積(指数減衰)
  heat = new Map<TileKey, number>();
  heatMax = 1;

  constructor(private rail: RailNetwork) {}

  private addHeat(k: TileKey, amount: number) {
    const v = (this.heat.get(k) ?? 0) + amount;
    this.heat.set(k, v);
    if (v > this.heatMax) this.heatMax = v;
  }

  private decayHeat(dt: number) {
    const f = Math.exp(-dt / 12);
    this.heatMax = Math.max(1, this.heatMax * f);
    for (const [k, v] of this.heat) {
      const nv = v * f;
      if (nv < 0.05) this.heat.delete(k);
      else this.heat.set(k, nv);
    }
  }

  idleCount(): number {
    return this.vehicles.filter((v) => v.state === 'idle').length;
  }

  // 渋滞回避ルーティング: 待たされた実績(渋滞ヒート)が溜まっているタイル
  // ほど進入コストを上げ、経路探索に混雑地帯を迂回させる
  private routeCost = (k: TileKey): number =>
    1 + HEAT_ROUTE_WEIGHT * Math.min(this.heat.get(k) ?? 0, HEAT_ROUTE_CLAMP);

  isOccupied(k: TileKey): boolean {
    return this.occ.has(k);
  }

  private isFree(k: TileKey): boolean {
    return !this.occ.has(k);
  }

  private release(k: TileKey, v: Vehicle) {
    if (this.occ.get(k) === v) this.occ.delete(k);
  }

  // 搬送ジョブの割り当て。アイドル機を差し向けるか、保有枠が余っていれば
  // ピックアップ地点に新規投入する。
  tryAssign(job: TransportJob): boolean {
    const fromKey = portKey(job.from);
    let best: { v: Vehicle; path: TileKey[] } | null = null;
    for (const v of this.vehicles) {
      if (v.state !== 'idle') continue;
      const start = v.target ?? v.tile;
      const p = this.rail.path(start, fromKey, this.routeCost);
      if (p && (!best || p.length < best.path.length)) best = { v, path: p };
    }
    if (best) {
      best.v.job = job;
      best.v.state = 'toPickup';
      best.v.path = best.path.slice(1);
      best.v.stuck = false;
      best.v.retryTimer = 0;
      this.startJourney(best.v);
      return true;
    }
    if (
      this.vehicles.length < this.size &&
      this.rail.hasNode(fromKey) &&
      this.isFree(fromKey)
    ) {
      const v = new Vehicle(fromKey);
      this.occ.set(fromKey, v);
      v.job = job;
      v.state = 'toPickup';
      this.startJourney(v);
      this.vehicles.push(v);
      return true;
    }
    return false;
  }

  // 現在地から目的地までの残りタイル数をジャーニー長として記録
  // (発車直後=加速、到着直前=減速の判定に使う)
  private startJourney(v: Vehicle) {
    v.journeyLen = Math.max(1, v.path.length + 1);
    v.journeyPos = 0;
  }

  // セーブデータからビークルを復元。ホイスト途中の状態は走行状態に正規化する
  restoreVehicle(
    tile: TileKey,
    state: VehState,
    carrying: Lot | null,
    job: TransportJob | null,
  ) {
    const v = new Vehicle(tile);
    if (!job) {
      v.state = 'idle';
    } else {
      v.job = job;
      v.carrying = carrying;
      v.state = carrying ? 'toDrop' : 'toPickup';
    }
    void state; // 現状は正規化するため未使用(将来ホイスト位置も保存する場合に使う)
    this.occ.set(tile, v);
    this.vehicles.push(v);
  }

  update(dt: number, portTiles: ReadonlySet<TileKey>) {
    this.decayHeat(dt);
    for (const v of [...this.vehicles]) this.updateVehicle(v, dt, portTiles);
  }

  private despawn(v: Vehicle) {
    this.release(v.tile, v);
    if (v.target) this.release(v.target, v);
    this.vehicles = this.vehicles.filter((x) => x !== v);
  }

  private updateVehicle(v: Vehicle, dt: number, portTiles: ReadonlySet<TileKey>) {
    switch (v.state) {
      case 'idle': {
        // 保有台数が減らされたら、手の空いた機体から退役
        if (this.vehicles.length > this.size && !v.target && !v.carrying) {
          this.despawn(v);
          return;
        }
        this.wander(v, dt, portTiles);
        return;
      }
      case 'toPickup':
      case 'toDrop':
        this.travel(v, dt);
        return;
      case 'pickDown': {
        v.hoistT = Math.min(1, v.hoistT + dt / HOIST_TIME);
        if (v.hoistT >= 1) {
          const p = v.job!.from;
          this.onPickup(p);
          v.carrying = p.foup;
          p.foup = null;
          p.reserved = false;
          v.state = 'pickUp';
        }
        return;
      }
      case 'pickUp': {
        v.hoistT = Math.max(0, v.hoistT - dt / HOIST_TIME);
        if (v.hoistT <= 0) {
          v.state = 'toDrop';
          v.path = [];
          v.stuck = false;
          v.retryTimer = 0;
        }
        return;
      }
      case 'dropDown': {
        v.hoistT = Math.min(1, v.hoistT + dt / HOIST_TIME);
        if (v.hoistT >= 1) {
          const p = v.job!.to;
          p.foup = v.carrying;
          p.reserved = false;
          v.carrying = null;
          v.state = 'dropUp';
        }
        return;
      }
      case 'dropUp': {
        v.hoistT = Math.max(0, v.hoistT - dt / HOIST_TIME);
        if (v.hoistT <= 0) {
          v.job = null;
          v.state = 'idle';
        }
        return;
      }
    }
  }

  private goalOf(v: Vehicle): TileKey {
    return v.state === 'toPickup' ? portKey(v.job!.from) : portKey(v.job!.to);
  }

  private travel(v: Vehicle, dt: number) {
    let remaining = dt * OHT_SPEED; // [タイル]
    let guard = 8;
    while (remaining > 0 && guard-- > 0) {
      if (!v.target) {
        const goal = this.goalOf(v);
        if (v.path.length === 0) {
          if (v.tile === goal) {
            // 到着 → ホイスト降下開始
            v.hoistT = 0;
            v.state = v.state === 'toPickup' ? 'pickDown' : 'dropDown';
            v.stuck = false;
            return;
          }
          // 経路を(再)計算。失敗したら1秒おきにリトライ
          v.retryTimer -= dt;
          if (v.retryTimer > 0) return;
          v.retryTimer = 1;
          const p = this.rail.path(v.tile, goal, this.routeCost);
          if (!p) {
            v.stuck = true;
            return;
          }
          v.path = p.slice(1);
          v.stuck = false;
          v.retryTimer = 0;
          this.startJourney(v); // 経路を引き直したので加減速の基準もリセット
          if (v.path.length === 0) continue;
        }
        const next = v.path[0];
        if (!this.rail.hasEdge(v.tile, next)) {
          v.path = []; // レールが撤去された → 再探索へ
          continue;
        }
        if (!this.isFree(next)) {
          this.addHeat(v.tile, dt); // 前方渋滞で待機
          return;
        }
        v.path.shift();
        v.target = next;
        this.occ.set(next, v);
        v.progress = 0;
      }
      // 発車直後・到着直前は減速係数を掛ける(区間の両端からの距離で判定)
      const factor = speedFactor(v.journeyPos + v.progress, v.journeyLen);
      const step = Math.min(remaining * factor, 1 - v.progress);
      v.progress += step;
      remaining -= step / Math.max(factor, 1e-3);
      if (v.progress >= 1) {
        this.release(v.tile, v);
        v.tile = v.target!;
        v.target = null;
        v.progress = 0;
        v.journeyPos++;
      }
    }
  }

  // アイドル時はゆっくり前進を続ける(ポート上で立ち往生して塞がないため)。
  // ポートタイルは実際の積み下ろし専用に空けておきたいので、空いている
  // 非ポートの行き先があればそちらを優先する。さもないと、装置のIN/OUT
  // タイルに複数のアイドル車両が居座って互いの唯一の出口を塞ぎ合い、
  // その装置が永久に積み下ろし不能になるデッドロックが起きる
  private wander(v: Vehicle, dt: number, portTiles: ReadonlySet<TileKey>) {
    if (!v.target) {
      let outs = this.rail.outEdges(v.tile).filter((k) => this.isFree(k));
      if (outs.length === 0) return;
      const nonPort = outs.filter((k) => !portTiles.has(k));
      if (nonPort.length > 0) outs = nonPort;
      const next = outs[Math.floor(Math.random() * outs.length)];
      v.target = next;
      this.occ.set(next, v);
      v.progress = 0;
    }
    v.progress += dt * OHT_IDLE_SPEED;
    if (v.progress >= 1) {
      this.release(v.tile, v);
      v.tile = v.target!;
      v.target = null;
      v.progress = 0;
    }
  }
}
