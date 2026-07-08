// 天井OHTレールの有向グラフ。ノード = タイル、エッジ = 隣接タイル間の一方通行区間。

export type TileKey = string; // "col,row"

export const tkey = (c: number, r: number): TileKey => `${c},${r}`;
export const parseKey = (k: TileKey): { c: number; r: number } => {
  const [c, r] = k.split(',').map(Number);
  return { c, r };
};

export class RailNetwork {
  private out = new Map<TileKey, Set<TileKey>>();
  private inc = new Map<TileKey, Set<TileKey>>();
  version = 0; // 変更検知用(描画の再構築トリガー)

  addEdge(a: TileKey, b: TileKey) {
    const pa = parseKey(a);
    const pb = parseKey(b);
    if (Math.abs(pa.c - pb.c) + Math.abs(pa.r - pb.r) !== 1) return; // 隣接のみ
    if (!this.out.has(a)) this.out.set(a, new Set());
    if (!this.inc.has(b)) this.inc.set(b, new Set());
    this.out.get(a)!.add(b);
    this.inc.get(b)!.add(a);
    this.version++;
  }

  hasEdge(a: TileKey, b: TileKey): boolean {
    return this.out.get(a)?.has(b) ?? false;
  }

  outEdges(a: TileKey): TileKey[] {
    return [...(this.out.get(a) ?? [])];
  }

  hasNode(k: TileKey): boolean {
    return (this.out.get(k)?.size ?? 0) > 0 || (this.inc.get(k)?.size ?? 0) > 0;
  }

  // タイルに接続する全エッジを撤去
  removeTile(k: TileKey) {
    for (const b of this.out.get(k) ?? []) this.inc.get(b)?.delete(k);
    this.out.delete(k);
    for (const a of this.inc.get(k) ?? []) this.out.get(a)?.delete(k);
    this.inc.delete(k);
    this.version++;
  }

  // 最短経路(タイル列、from を含む)。到達不能なら null。
  // cost を渡すとタイルへの進入コスト(>=1)を織り込んだ最小コスト経路になる
  // (渋滞回避ルーティング用)。省略時は純粋なホップ数最短(BFS)
  path(
    from: TileKey, to: TileKey, cost?: (k: TileKey) => number,
  ): TileKey[] | null {
    if (from === to) return [from];
    if (!this.hasNode(from) || !this.hasNode(to)) return null;
    if (cost) return this.dijkstra(from, to, cost);
    const prev = new Map<TileKey, TileKey>();
    const queue: TileKey[] = [from];
    prev.set(from, from);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of this.out.get(cur) ?? []) {
        if (prev.has(next)) continue;
        prev.set(next, cur);
        if (next === to) {
          const result: TileKey[] = [to];
          let node = to;
          while (node !== from) {
            node = prev.get(node)!;
            result.push(node);
          }
          return result.reverse();
        }
        queue.push(next);
      }
    }
    return null;
  }

  // コスト付き最短経路。ノード数は高々マップタイル数なので線形走査で十分
  private dijkstra(
    from: TileKey, to: TileKey, cost: (k: TileKey) => number,
  ): TileKey[] | null {
    const dist = new Map<TileKey, number>([[from, 0]]);
    const prev = new Map<TileKey, TileKey>();
    const done = new Set<TileKey>();
    for (;;) {
      let cur: TileKey | null = null;
      let curDist = Infinity;
      for (const [k, d] of dist) {
        if (!done.has(k) && d < curDist) {
          cur = k;
          curDist = d;
        }
      }
      if (cur === null) return null; // 到達不能
      if (cur === to) break;
      done.add(cur);
      for (const next of this.out.get(cur) ?? []) {
        const nd = curDist + Math.max(1, cost(next));
        if (nd < (dist.get(next) ?? Infinity)) {
          dist.set(next, nd);
          prev.set(next, cur);
        }
      }
    }
    const result: TileKey[] = [to];
    let node = to;
    while (node !== from) {
      node = prev.get(node)!;
      result.push(node);
    }
    return result.reverse();
  }

  // from から到達可能な全ノード(ディスパッチの行き先フィルタ用)
  reachableFrom(from: TileKey): Set<TileKey> {
    const seen = new Set<TileKey>();
    if (!this.hasNode(from)) return seen;
    seen.add(from);
    const queue: TileKey[] = [from];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      for (const next of this.out.get(cur) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return seen;
  }

  // 描画用に全エッジを列挙
  allEdges(): [TileKey, TileKey][] {
    const result: [TileKey, TileKey][] = [];
    for (const [a, bs] of this.out) for (const b of bs) result.push([a, b]);
    return result;
  }

  allNodes(): TileKey[] {
    const s = new Set<TileKey>([...this.out.keys(), ...this.inc.keys()]);
    return [...s].filter((k) => this.hasNode(k));
  }
}
