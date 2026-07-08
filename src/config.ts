// ---- マップ・タイル ----
export const TILE = 48;          // 1タイル [px](ワールド座標)
export const MAP_COLS = 34;      // 装置9種+混流に耐える広さ
export const MAP_ROWS = 20;

// ---- 装置 ----
// 工程はFEOL(トランジスタ形成: 酸化・露光・エッチ・注入・アニール)と
// BEOL(配線形成: CVD成膜・露光・エッチ・メタル・CMP)の2部構成。
// 注入はFEOL専用、メタル/CMPはBEOL専用で、自然と上流/下流のゾーニングが生まれる
export type MachineKind =
  | 'load'    // 投入ステーション
  | 'clean'   // 洗浄
  | 'depo'    // 成膜(CVD: 絶縁膜・層間膜)
  | 'litho'   // i線露光(〜130nm)
  | 'duv'     // DUV露光(全世代対応。90nm以降はこれが必須)
  | 'etch'    // エッチング
  | 'furnace' // 拡散炉(バッチ処理: 酸化/アニール)
  | 'implant' // イオン注入(FEOL)
  | 'metal'   // メタル成膜(PVDスパッタ、BEOL)
  | 'cmp'     // CMP平坦化(BEOL)
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
  cost: number;       // 購入価格 [¥]
  procTime: number;   // 処理時間 [秒]
  baseDefect: number; // 1工程あたりの基礎欠陥率
  wear: number;       // 1ジョブごとの清浄度低下
  placeable: boolean;
  // この装置が担う工程種。省略時は自分自身のkind。ティア違いの装置
  // (例: DUV露光は 'litho' 工程を担う)をレシピに合流させるために使う
  serves?: MachineKind;
  desc: string;
  ports: PortSpec[];  // ロードポート(南面に付く)
}

// 装置kindが担う工程種を解決する
export function servesOf(kind: MachineKind): MachineKind {
  return MACHINE_DEFS[kind].serves ?? kind;
}

// ロードポートは全装置とも南面(dy = h-1 の行)。OHTレールが
// ポートタイルの真上を通っていないと搬送できない。
export const MACHINE_DEFS: Record<MachineKind, MachineDef> = {
  load: {
    name: '投入ステーション', short: '投入', accent: '#78909c',
    w: 2, h: 2, cost: 0, procTime: 0, baseDefect: 0, wear: 0, placeable: false,
    desc: '新しいロット(FOUP)がここに払い出される',
    ports: [{ dx: 0, dy: 1, io: 'out' }, { dx: 1, dy: 1, io: 'out' }],
  },
  clean: {
    name: '洗浄装置', short: 'CLN', accent: '#4f9cc7',
    w: 2, h: 2, cost: 2000, procTime: 2, baseDefect: 0.005, wear: 0.02, placeable: true,
    desc: 'ウェハ表面を洗浄する。速くて汚れにくい',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  depo: {
    name: '成膜装置', short: 'DEP', accent: '#8e7cc3',
    w: 2, h: 2, cost: 3000, procTime: 3, baseDefect: 0.02, wear: 0.035, placeable: true,
    desc: '薄膜を堆積させる。使うほど汚れる',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  litho: {
    name: 'i線露光装置', short: 'LITHO', accent: '#c7a13f',
    w: 3, h: 2, cost: 8000, procTime: 4, baseDefect: 0.025, wear: 0.03, placeable: true,
    desc: '回路パターンを転写する。多くの製品が複数回通るボトルネックの要衝。130nmまでの世代しか露光できない',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  duv: {
    name: 'DUV露光装置', short: 'DUV', accent: '#6d5fc7',
    w: 3, h: 2, cost: 20000, procTime: 2.5, baseDefect: 0.015, wear: 0.025, placeable: true,
    serves: 'litho',
    desc: '深紫外スキャナ。高価だが速く欠陥も少なく、全世代を露光できる。90nm以降のロットの露光はこれが必須',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  etch: {
    name: 'エッチング装置', short: 'ETCH', accent: '#c77e4f',
    w: 2, h: 2, cost: 3000, procTime: 3, baseDefect: 0.02, wear: 0.035, placeable: true,
    desc: 'パターンに沿って膜を削る',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  furnace: {
    name: '拡散炉', short: 'FUR', accent: '#b3574d',
    w: 3, h: 2, cost: 5000, procTime: 12, baseDefect: 0.008, wear: 0.05, placeable: true,
    desc: 'バッチ炉。最大3ロットを同時に酸化/アニール処理。満載で焼くほど効率的だが、待ちすぎるとフローが淀む',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  implant: {
    name: 'イオン注入装置', short: 'IMP', accent: '#3f9a96',
    w: 3, h: 2, cost: 6000, procTime: 5, baseDefect: 0.008, wear: 0.02, placeable: true,
    desc: '不純物イオンを打ち込みトランジスタを形成する(FEOL専用)。高価だが清浄で欠陥が少ない',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  metal: {
    name: 'メタル成膜装置', short: 'PVD', accent: '#b06a9a',
    w: 2, h: 2, cost: 3500, procTime: 3, baseDefect: 0.015, wear: 0.03, placeable: true,
    desc: 'スパッタで配線金属を成膜する(BEOL専用)',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  cmp: {
    name: 'CMP装置', short: 'CMP', accent: '#8d6e5c',
    w: 2, h: 2, cost: 4000, procTime: 3, baseDefect: 0.02, wear: 0.06, placeable: true,
    desc: 'ウェハ表面を研磨して平坦化する。配線層ごとに再訪するBEOLの要衝。スラリーで最も汚れやすい',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  inspect: {
    name: '検査装置', short: 'INS', accent: '#6aa86e',
    w: 2, h: 1, cost: 1500, procTime: 2, baseDefect: 0, wear: 0.01, placeable: true,
    desc: '最終検査。歩留まりが確定し、低すぎるロットは廃棄される',
    ports: [{ dx: 0, dy: 0, io: 'in' }, { dx: 1, dy: 0, io: 'out' }],
  },
  stocker: {
    name: 'ストッカー', short: 'STK', accent: '#7887a0',
    w: 2, h: 2, cost: 1200, procTime: 0, baseDefect: 0, wear: 0, placeable: true,
    desc: 'FOUPの自動倉庫。行き先が満杯のロットを退避させ、詰まり(デッドロック)を防ぐ',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  ship: {
    name: '出荷ステーション', short: '出荷', accent: '#78909c',
    w: 2, h: 2, cost: 0, procTime: 0, baseDefect: 0, wear: 0, placeable: false,
    desc: '完成ロットの搬出先',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'in' }],
  },
};

// ---- 製品と工程レシピ ----
export interface RecipeStep {
  kind: MachineKind;
  label: string;
}

export type ProductId = 'diode' | 'logic' | 'power' | 'dram' | 'flash' | 'cpu';

export interface Product {
  id: ProductId;
  name: string;
  color: string;    // FOUPタグ・UIの識別色(固定順の categorical)
  unlockAt: number; // 累計完成ロット数で解禁
  price: number;    // 出荷単価 [¥/ロット]。実売上は 単価×歩留まり×世代ボーナス
  waferCost: number; // 投入時に支払うウェハ原価 [¥/ロット]
  steps: RecipeStep[];
}

const s = (kind: MachineKind, label: string): RecipeStep => ({ kind, label });

// レシピはFEOL→(モジュール工程)→BEOL→検査の構造。製品ごとに工程の
// 配合比が違うので、混流するとボトルネックの位置が製品ミックスで変わる:
//  - パワーMOSFET: 炉・注入が中心で露光が少ない(BEOLもCMP不要)
//  - フラッシュ: 成膜・エッチの繰り返しが極端に多い(注入なし)
//  - CPU: 露光・CMPの再訪が最多
export const PRODUCTS: Record<ProductId, Product> = {
  diode: {
    id: 'diode', name: 'ダイオード', color: '#3f8f7a', unlockAt: 0,
    price: 500, waferCost: 120,
    steps: [
      s('clean', '洗浄'),
      s('furnace', '酸化'),
      s('litho', '露光'),
      s('etch', 'エッチング'),
      s('implant', '注入'),
      s('furnace', 'アニール'),
      s('inspect', '検査'),
    ],
  },
  logic: {
    id: 'logic', name: 'ロジックIC', color: '#4a7dbb', unlockAt: 6,
    price: 1300, waferCost: 300,
    steps: [
      // FEOL
      s('clean', '初期洗浄'),
      s('furnace', '酸化'),
      s('litho', '露光 (ゲート)'),
      s('etch', 'エッチング (ゲート)'),
      s('implant', '注入'),
      s('furnace', 'アニール'),
      // BEOL 1層
      s('depo', '成膜 (層間膜)'),
      s('litho', '露光 (配線)'),
      s('etch', 'エッチング (配線)'),
      s('metal', 'メタル成膜'),
      s('cmp', 'CMP平坦化'),
      s('inspect', '検査'),
    ],
  },
  power: {
    id: 'power', name: 'パワーMOSFET', color: '#96833b', unlockAt: 15,
    price: 1600, waferCost: 350,
    steps: [
      s('clean', '初期洗浄'),
      s('furnace', '酸化 (ゲート)'),
      s('litho', '露光 (セル)'),
      s('etch', 'エッチング (セル)'),
      s('implant', '注入 (ボディ)'),
      s('furnace', 'アニール ①'),
      s('implant', '注入 (ソース)'),
      s('furnace', 'アニール ②'),
      s('metal', 'メタル成膜 (電極)'),
      s('inspect', '検査'),
    ],
  },
  dram: {
    id: 'dram', name: 'DRAM', color: '#b05fa3', unlockAt: 30,
    price: 2400, waferCost: 550,
    steps: [
      // FEOL
      s('clean', '初期洗浄'),
      s('furnace', '酸化'),
      s('litho', '露光 (ゲート)'),
      s('etch', 'エッチング (ゲート)'),
      s('implant', '注入'),
      s('furnace', 'アニール'),
      // キャパシタモジュール
      s('depo', '成膜 (キャパシタ)'),
      s('litho', '露光 (キャパシタ)'),
      s('etch', 'エッチング (キャパシタ)'),
      s('furnace', 'アニール (high-k)'),
      // BEOL 1層
      s('depo', '成膜 (層間膜)'),
      s('litho', '露光 (配線)'),
      s('etch', 'エッチング (配線)'),
      s('metal', 'メタル成膜'),
      s('cmp', 'CMP平坦化'),
      s('inspect', '検査'),
    ],
  },
  flash: {
    id: 'flash', name: 'フラッシュメモリ', color: '#6a5ac2', unlockAt: 45,
    price: 2800, waferCost: 650,
    steps: [
      s('clean', '初期洗浄'),
      // 積層モジュール(3Dセル)
      s('depo', '成膜 (積層 ①)'),
      s('depo', '成膜 (積層 ②)'),
      s('depo', '成膜 (積層 ③)'),
      s('litho', '露光 (チャネル)'),
      s('etch', 'エッチング (深穴 ①)'),
      s('etch', 'エッチング (深穴 ②)'),
      s('depo', '成膜 (チャネル)'),
      s('furnace', 'アニール'),
      // BEOL 1層
      s('depo', '成膜 (層間膜)'),
      s('litho', '露光 (配線)'),
      s('etch', 'エッチング (配線)'),
      s('metal', 'メタル成膜'),
      s('cmp', 'CMP平坦化'),
      s('inspect', '検査'),
    ],
  },
  cpu: {
    id: 'cpu', name: 'CPU', color: '#c26b3d', unlockAt: 70,
    price: 4000, waferCost: 900,
    steps: [
      // FEOL(注入2回)
      s('clean', '初期洗浄'),
      s('furnace', '酸化'),
      s('implant', '注入 (ウェル)'),
      s('litho', '露光 (ゲート)'),
      s('etch', 'エッチング (ゲート)'),
      s('implant', '注入 (S/D)'),
      s('furnace', 'アニール'),
      s('clean', '中間洗浄'),
      // BEOL 2層
      s('depo', '成膜 (層間膜 ①)'),
      s('litho', '露光 (配線 ①)'),
      s('etch', 'エッチング (配線 ①)'),
      s('metal', 'メタル成膜 ①'),
      s('cmp', 'CMP平坦化 ①'),
      s('depo', '成膜 (層間膜 ②)'),
      s('litho', '露光 (配線 ②)'),
      s('etch', 'エッチング (配線 ②)'),
      s('metal', 'メタル成膜 ②'),
      s('cmp', 'CMP平坦化 ②'),
      s('inspect', '検査'),
    ],
  },
};

export const PRODUCT_ORDER: ProductId[] =
  ['diode', 'logic', 'power', 'dram', 'flash', 'cpu'];

// ---- プロセスノード(微細化)----
// 同じ製品でも量産を重ねると世代が進み、微細化する。世代が1つ上がるごとに
// 配線層が1層増える(=成膜→露光→エッチングの1サイクルが最終検査の直前に
// 挿入される)。工程が伸びるほど欠陥が積み増され、歩留まり維持が難しくなる。
export const PROCESS_NODES = ['250nm', '180nm', '130nm', '90nm', '65nm', '45nm'];
export const MAX_GEN = PROCESS_NODES.length - 1;
export const GEN_STEP = 20; // この数だけ量産するごとに1世代進む
// 露光ティア制: この世代(90nm)以降のロットの露光はDUV露光装置が必須。
// i線露光装置では処理できず、量産が進んだ製品は設備更新を迫られる
export const DUV_GEN = 3;

export function nodeLabel(gen: number): string {
  return PROCESS_NODES[Math.max(0, Math.min(gen, MAX_GEN))];
}

// 累計完成数から到達世代を求める
export function genFromCompleted(completed: number): number {
  return Math.min(MAX_GEN, Math.floor(completed / GEN_STEP));
}

// 世代を織り込んだ工程レシピ。gen=0 は基本レシピそのもの。
// 世代が進むごとに配線1層(ダマシン: 成膜→露光→エッチ→メタル→CMP)を
// 最終検査の直前へ挿入する。基本レシピにメタル/CMPが無い製品(ダイオード・
// パワー)も、微細化するとBEOL装置が必要になる点に注意
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
      s('metal', `メタル成膜 (微細化層${i})`),
      s('cmp', `CMP (微細化層${i})`),
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

// ---- 経済 ----
// ライン拡張(装置・OHT・レール)を「どこに投資するか」の意思決定にするための
// コスト制約。収入は出荷売上のみ: 単価 × 歩留まり × (1 + 世代ボーナス)
export const START_MONEY = 30000;
export const OHT_COST = 2000;         // OHTビークル1台の購入価格
export const RAIL_COST = 25;          // レール1区間(エッジ)あたりの敷設費
export const SELL_RATIO = 0.5;        // 装置撤去・OHT売却・レール撤去の払い戻し率
export const NODE_PRICE_BONUS = 0.25; // プロセス世代が1つ進むごとの単価上乗せ率
                                      // (微細化はダマシン5工程追加と重いぶん高め)

// ---- シミュレーション定数 ----
export const UTIL_TAU = 45;           // 装置稼働率EMAの時定数 [秒]
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
// v4: レシピ体系をFEOL/BEOL構造へ刷新。旧セーブの仕掛かりロットは
// 新レシピと工程番号が整合しないため、移行時に破棄する(工場・資金は維持)
export const SAVE_VERSION = 4;
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
export const MAX_FLEET = 16; // 工程数の増加(FEOL/BEOL化)に合わせて拡大
