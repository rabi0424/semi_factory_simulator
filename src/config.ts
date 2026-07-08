// ---- マップ・タイル ----
export const TILE = 48;          // 1タイル [px](ワールド座標)
export const MAP_COLS = 30;
export const MAP_ROWS = 18;

// ---- 装置 ----
export type MachineKind =
  | 'load'    // 投入ステーション
  | 'clean'   // 洗浄
  | 'depo'    // 成膜
  | 'litho'   // 露光
  | 'etch'    // エッチング
  | 'furnace' // 拡散炉(バッチ処理: 酸化/アニール)
  | 'inspect' // 検査
  | 'stocker' // ストッカー(FOUP自動倉庫)
  | 'ship';   // 出荷ステーション

export interface PortSpec {
  dx: number;       // フットプリント内の相対タイル位置
  dy: number;
  io: 'in' | 'out';
}

export interface MachineDef {
  name: string;
  short: string;
  accent: string;     // 筐体のアクセントライン色
  w: number;          // フットプリント [タイル]
  h: number;
  procTime: number;   // 処理時間 [秒]
  baseDefect: number; // 1工程あたりの基礎欠陥率
  wear: number;       // 1ジョブごとの清浄度低下
  placeable: boolean;
  desc: string;
  ports: PortSpec[];  // ロードポート(南面に付く)
}

// ロードポートは全装置とも南面(dy = h-1 の行)。OHTレールが
// ポートタイルの真上を通っていないと搬送できない。
export const MACHINE_DEFS: Record<MachineKind, MachineDef> = {
  load: {
    name: '投入ステーション', short: '投入', accent: '#78909c',
    w: 2, h: 2, procTime: 0, baseDefect: 0, wear: 0, placeable: false,
    desc: '新しいロット(FOUP)がここに払い出される',
    ports: [{ dx: 0, dy: 1, io: 'out' }, { dx: 1, dy: 1, io: 'out' }],
  },
  clean: {
    name: '洗浄装置', short: 'CLN', accent: '#4f9cc7',
    w: 2, h: 2, procTime: 2, baseDefect: 0.005, wear: 0.02, placeable: true,
    desc: 'ウェハ表面を洗浄する。速くて汚れにくい',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  depo: {
    name: '成膜装置', short: 'DEP', accent: '#8e7cc3',
    w: 2, h: 2, procTime: 3, baseDefect: 0.02, wear: 0.035, placeable: true,
    desc: '薄膜を堆積させる。使うほど汚れる',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  litho: {
    name: '露光装置', short: 'LITHO', accent: '#c7a13f',
    w: 3, h: 2, procTime: 4, baseDefect: 0.025, wear: 0.03, placeable: true,
    desc: '回路パターンを転写する。工場最大の装置。多くの製品が複数回通り、ボトルネックになりやすい要衝',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  etch: {
    name: 'エッチング装置', short: 'ETCH', accent: '#c77e4f',
    w: 2, h: 2, procTime: 3, baseDefect: 0.02, wear: 0.035, placeable: true,
    desc: 'パターンに沿って膜を削る',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  furnace: {
    name: '拡散炉', short: 'FUR', accent: '#b3574d',
    w: 3, h: 2, procTime: 12, baseDefect: 0.008, wear: 0.05, placeable: true,
    desc: 'バッチ炉。最大3ロットを同時に酸化/アニール処理。満載で焼くほど効率的だが、待ちすぎるとフローが淀む',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  inspect: {
    name: '検査装置', short: 'INS', accent: '#6aa86e',
    w: 2, h: 1, procTime: 2, baseDefect: 0, wear: 0.01, placeable: true,
    desc: '最終検査。歩留まりが確定し、低すぎるロットは廃棄される',
    ports: [{ dx: 0, dy: 0, io: 'in' }, { dx: 1, dy: 0, io: 'out' }],
  },
  stocker: {
    name: 'ストッカー', short: 'STK', accent: '#7887a0',
    w: 2, h: 2, procTime: 0, baseDefect: 0, wear: 0, placeable: true,
    desc: 'FOUPの自動倉庫。行き先が満杯のロットを退避させ、詰まり(デッドロック)を防ぐ',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  ship: {
    name: '出荷ステーション', short: '出荷', accent: '#78909c',
    w: 2, h: 2, procTime: 0, baseDefect: 0, wear: 0, placeable: false,
    desc: '完成ロットの搬出先',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'in' }],
  },
};

// ---- 製品と工程レシピ ----
export interface RecipeStep {
  kind: MachineKind;
  label: string;
}

export type ProductId = 'diode' | 'logic' | 'dram' | 'cpu';

export interface Product {
  id: ProductId;
  name: string;
  color: string;    // FOUPタグ・UIの識別色(固定順の categorical)
  unlockAt: number; // 累計完成ロット数で解禁
  steps: RecipeStep[];
}

const s = (kind: MachineKind, label: string): RecipeStep => ({ kind, label });

export const PRODUCTS: Record<ProductId, Product> = {
  diode: {
    id: 'diode', name: 'ダイオード', color: '#3f8f7a', unlockAt: 0,
    steps: [
      s('clean', '洗浄'),
      s('furnace', '酸化'),
      s('litho', '露光'),
      s('etch', 'エッチング'),
      s('inspect', '検査'),
    ],
  },
  logic: {
    id: 'logic', name: 'ロジックIC', color: '#4a7dbb', unlockAt: 6,
    steps: [
      s('clean', '初期洗浄'),
      s('depo', '成膜 ①'),
      s('litho', '露光 ①'),
      s('etch', 'エッチング ①'),
      s('depo', '成膜 ②'),
      s('litho', '露光 ②'),
      s('etch', 'エッチング ②'),
      s('clean', '最終洗浄'),
      s('inspect', '検査'),
    ],
  },
  dram: {
    id: 'dram', name: 'DRAM', color: '#b05fa3', unlockAt: 30,
    steps: [
      s('clean', '初期洗浄'),
      s('furnace', '酸化'),
      s('depo', '成膜 ①'),
      s('litho', '露光 ①'),
      s('etch', 'エッチング ①'),
      s('depo', '成膜 ②'),
      s('litho', '露光 ②'),
      s('etch', 'エッチング ②'),
      s('furnace', 'アニール'),
      s('depo', '成膜 ③'),
      s('litho', '露光 ③'),
      s('etch', 'エッチング ③'),
      s('inspect', '検査'),
    ],
  },
  cpu: {
    id: 'cpu', name: 'CPU', color: '#c26b3d', unlockAt: 70,
    steps: [
      s('clean', '初期洗浄'),
      s('furnace', '酸化'),
      s('depo', '成膜 ①'),
      s('litho', '露光 ①'),
      s('etch', 'エッチング ①'),
      s('depo', '成膜 ②'),
      s('litho', '露光 ②'),
      s('etch', 'エッチング ②'),
      s('clean', '中間洗浄'),
      s('furnace', 'アニール'),
      s('depo', '成膜 ③'),
      s('litho', '露光 ③'),
      s('etch', 'エッチング ③'),
      s('depo', '成膜 ④'),
      s('litho', '露光 ④'),
      s('etch', 'エッチング ④'),
      s('inspect', '検査'),
    ],
  },
};

export const PRODUCT_ORDER: ProductId[] = ['diode', 'logic', 'dram', 'cpu'];

// ---- プロセスノード(微細化)----
// 同じ製品でも量産を重ねると世代が進み、微細化する。世代が1つ上がるごとに
// 配線層が1層増える(=成膜→露光→エッチングの1サイクルが最終検査の直前に
// 挿入される)。工程が伸びるほど欠陥が積み増され、歩留まり維持が難しくなる。
export const PROCESS_NODES = ['250nm', '180nm', '130nm', '90nm', '65nm', '45nm'];
export const MAX_GEN = PROCESS_NODES.length - 1;
export const GEN_STEP = 20; // この数だけ量産するごとに1世代進む

export function nodeLabel(gen: number): string {
  return PROCESS_NODES[Math.max(0, Math.min(gen, MAX_GEN))];
}

// 累計完成数から到達世代を求める
export function genFromCompleted(completed: number): number {
  return Math.min(MAX_GEN, Math.floor(completed / GEN_STEP));
}

// 世代を織り込んだ工程レシピ。gen=0 は基本レシピそのもの。
// 世代ぶんの追加配線層(depo→litho→etch)を最終工程の直前へ挿入する。
export function stepsForGen(product: ProductId, gen: number): RecipeStep[] {
  const base = PRODUCTS[product].steps;
  const g = Math.max(0, Math.min(gen, MAX_GEN));
  if (g === 0) return base;
  const extra: RecipeStep[] = [];
  for (let i = 1; i <= g; i++) {
    extra.push(
      s('depo', `成膜 (微細化層${i})`),
      s('litho', `露光 (微細化層${i})`),
      s('etch', `エッチング (微細化層${i})`),
    );
  }
  return [...base.slice(0, -1), ...extra, base[base.length - 1]];
}

// gen を明示しない呼び出しは基本レシピ(gen=0)として扱う
export function stepsOf(product: ProductId, gen = 0): RecipeStep[] {
  return stepsForGen(product, gen);
}

// ---- 回転 ----
// rot = 時計回り90°の回数。ポート面: 0=南, 1=西, 2=北, 3=東
export function rotSize(def: MachineDef, rot: number): { w: number; h: number } {
  return rot % 2 === 0 ? { w: def.w, h: def.h } : { w: def.h, h: def.w };
}

export interface RotatedPort extends PortSpec {
  fx: number; // ポートが向く外側方向(単位ベクトル)
  fy: number;
}

export function rotPorts(def: MachineDef, rot: number): RotatedPort[] {
  return def.ports.map((p) => {
    let dx = p.dx;
    let dy = p.dy;
    for (let i = 0; i < rot; i++) {
      // 90°CW: (x,y) -> (h-1-y, x)。グリッドの h は回転前の高さ
      const size = rotSize(def, i);
      [dx, dy] = [size.h - 1 - dy, dx];
    }
    const faces = [
      { fx: 0, fy: 1 }, { fx: -1, fy: 0 }, { fx: 0, fy: -1 }, { fx: 1, fy: 0 },
    ][rot % 4];
    return { dx, dy, io: p.io, ...faces };
  });
}

// ---- シミュレーション定数 ----
export const MIN_CLEANLINESS = 0.2;
export const SCRAP_THRESHOLD = 0.4;   // 検査でこれ未満は廃棄
export const YIELD_WINDOW = 30;       // 平均歩留まりの移動平均サンプル数(直近完成ロット)
export const DEFAULT_SPAWN_INTERVAL = 10;
export const STOCKER_CAP = 6;         // ストッカーの内部保管数
export const FURNACE_BATCH = 3;       // 拡散炉の同時処理ロット数
export const FURNACE_WAIT = 10;       // 満載を待つ最大時間 [秒](超えたら装填分だけで処理開始)

// ---- 故障 ----
// 1ジョブ完了ごとに故障判定。汚れているほど壊れやすい
export const FAIL_BASE = 0.004;       // 清浄度100%時の故障率/ジョブ
export const FAIL_DIRTY_COEF = 0.09;  // (1-清浄度) に掛かる係数
export const REPAIR_TIME = 25;        // 修理所要 [秒]

// ---- セーブ ----
export const SAVE_KEY = 'semifab.save.v1';
export const SAVE_VERSION = 3;
export const AUTOSAVE_INTERVAL = 10;  // [実秒]

// ---- OHT(天井搬送) ----
// 渋滞回避ルーティング: ビークルが待たされた場所(渋滞ヒート)を経路コストに
// 加算し、混雑地帯を迂回させる。クランプで1タイルあたりの最大迂回許容量を抑える
export const HEAT_ROUTE_WEIGHT = 0.5; // ヒート1秒あたりの追加コスト [タイル換算]
export const HEAT_ROUTE_CLAMP = 6;    // コストに算入するヒートの上限 [秒]
export const OHT_SPEED = 6;           // 巡航速度 [タイル/秒]
export const OHT_IDLE_SPEED = 5;      // 空走(巡回)速度。遅すぎると後続の実車を塞ぐ
export const OHT_ACCEL_TILES = 1;     // 発車/到着時の加減速に使うタイル数
export const OHT_MIN_SPEED_FACTOR = 0.4; // 加減速区間の最低速度係数(巡航速度に対する比)
export const HOIST_TIME = 0.5;        // 吊り上げ/下ろし片道 [秒]
export const START_FLEET = 3;
export const MAX_FLEET = 12;
