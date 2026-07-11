// ---- マップ・タイル ----
export const TILE = 48;          // 1タイル [px](ワールド座標)
export const MAP_COLS = 44;      // 複数ラインと装置ティア増に耐える広さ
export const MAP_ROWS = 26;
export const CEIL_Y = 3.3;       // クリーンルーム天井(FFU面)の高さ [タイル]

// ---- 装置 ----
// 工程はFEOL(トランジスタ形成: 酸化・露光・エッチ・注入・アニール)と
// BEOL(配線形成: CVD成膜・露光・エッチ・メタル・CMP)の2部構成。
// 注入はFEOL専用、メタル/CMPはBEOL専用で、自然と上流/下流のゾーニングが生まれる。
// 露光は世代準拠の5ティア(i線→KrF→ArF液浸→EUV→High-NA EUV)、メタルは
// Alスパッタ→Cuめっきの2ティア、45nm以降はゲート絶縁膜ALDが新工程として加わる
export type MachineKind =
  | 'load'    // 投入ステーション
  | 'clean'   // 洗浄
  | 'depo'    // 成膜(CVD: 絶縁膜・層間膜)
  | 'litho'   // i線露光(〜180nm)
  | 'krf'     // KrFスキャナ(〜90nm)
  | 'arf'     // ArF液浸スキャナ(〜32nm単, MPで7nmまで)
  | 'euv'     // EUV露光(〜5nm単, MPで2nmまで)
  | 'euvhna'  // High-NA EUV露光(2nmも単パターン)
  | 'etch'    // エッチング
  | 'furnace' // 拡散炉(バッチ処理: 酸化/アニール)
  | 'implant' // イオン注入(FEOL)
  | 'ald'     // ALD(原子層堆積: 45nm以降のゲート絶縁膜/high-k)
  | 'metal'   // メタル成膜(Al PVDスパッタ、BEOL)
  | 'cu'      // Cuめっき(ECD: 45nm以降のBEOLに必須)
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
  // (例: KrF/ArF/EUVは 'litho' 工程を担う)をレシピに合流させるために使う
  serves?: MachineKind;
  // 露光装置のティア(0=i線, 1=KrF, 2=ArF液浸, 3=EUV, 4=High-NA)。露光機のみ
  lithoTier?: number;
  category: BuildCategory; // 建設メニューの分類
  desc: string;
  ports: PortSpec[];  // ロードポート(南面に付く)
}

// 建設メニューの分類(ホットバー刷新: カテゴリタブ式)
export type BuildCategory = 'station' | 'litho' | 'thermal' | 'depoetch' | 'beol' | 'logistics';

// 装置kindが担う工程種を解決する
export function servesOf(kind: MachineKind): MachineKind {
  return MACHINE_DEFS[kind].serves ?? kind;
}

// ロードポートは全装置とも南面(dy = h-1 の行)。OHTレールが
// ポートタイルの真上を通っていないと搬送できない。
export const MACHINE_DEFS: Record<MachineKind, MachineDef> = {
  load: {
    name: '投入ステーション', short: '投入', accent: '#78909c',
    w: 2, h: 2, cost: 4000, procTime: 0, baseDefect: 0, wear: 0, placeable: true,
    category: 'station',
    desc: '生産ライン単位で製品・プロセスノード・露光技術・投入間隔を設定できる。複数設置して製品を作り分ける',
    ports: [{ dx: 0, dy: 1, io: 'out' }, { dx: 1, dy: 1, io: 'out' }],
  },
  clean: {
    name: '洗浄装置', short: 'CLN', accent: '#4f9cc7',
    w: 2, h: 2, cost: 2000, procTime: 2, baseDefect: 0.005, wear: 0.02, placeable: true,
    category: 'depoetch',
    desc: 'ウェハ表面を洗浄する。速くて汚れにくい',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  depo: {
    name: '成膜装置', short: 'DEP', accent: '#8e7cc3',
    w: 2, h: 2, cost: 3000, procTime: 3, baseDefect: 0.02, wear: 0.035, placeable: true,
    category: 'depoetch',
    desc: '薄膜を堆積させる(CVD)。使うほど汚れる',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  litho: {
    name: 'i線露光装置', short: 'i線', accent: '#c7a13f',
    w: 3, h: 2, cost: 8000, procTime: 4, baseDefect: 0.025, wear: 0.03, placeable: true,
    serves: 'litho', lithoTier: 0, category: 'litho',
    desc: '水銀i線ステッパ。180nmまでを単パターンで露光(130nmはダブルパターニング)。安価だが遅く欠陥も多い',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  krf: {
    name: 'KrFスキャナ', short: 'KrF', accent: '#6d8fc7',
    w: 3, h: 2, cost: 20000, procTime: 3, baseDefect: 0.018, wear: 0.028, placeable: true,
    serves: 'litho', lithoTier: 1, category: 'litho',
    desc: 'KrFエキシマ(248nm)スキャナ。90nmまでを単パターン、65nmはDPで露光',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  arf: {
    name: 'ArF液浸スキャナ', short: 'ArFi', accent: '#5f7fc7',
    w: 3, h: 2, cost: 60000, procTime: 2.5, baseDefect: 0.013, wear: 0.025, placeable: true,
    serves: 'litho', lithoTier: 2, category: 'litho',
    desc: 'ArF液浸(193i)スキャナ。32nmまで単パターン。22〜7nmはマルチパターニング(露光を複数回)で対応',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  euv: {
    name: 'EUV露光装置', short: 'EUV', accent: '#6d5fc7',
    w: 3, h: 2, cost: 180000, procTime: 2.5, baseDefect: 0.011, wear: 0.022, placeable: true,
    serves: 'litho', lithoTier: 3, category: 'litho',
    desc: '極端紫外(13.5nm)スキャナ。5nmまで単パターン、3〜2nmはMPで対応。極めて高価',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  euvhna: {
    name: 'High-NA EUV', short: 'hNA', accent: '#8a5fc7',
    w: 3, h: 2, cost: 400000, procTime: 2.5, baseDefect: 0.009, wear: 0.02, placeable: true,
    serves: 'litho', lithoTier: 4, category: 'litho',
    desc: '高開口数(0.55NA)EUVスキャナ。2nmすら単パターンで露光できる最終兵器',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  etch: {
    name: 'エッチング装置', short: 'ETCH', accent: '#c77e4f',
    w: 2, h: 2, cost: 3000, procTime: 3, baseDefect: 0.02, wear: 0.035, placeable: true,
    category: 'depoetch',
    desc: 'パターンに沿って膜を削る',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  furnace: {
    name: '拡散炉', short: 'FUR', accent: '#b3574d',
    w: 3, h: 2, cost: 5000, procTime: 12, baseDefect: 0.008, wear: 0.05, placeable: true,
    category: 'thermal',
    desc: 'バッチ炉。最大3ロットを同時に酸化/アニール処理。満載で焼くほど効率的だが、待ちすぎるとフローが淀む',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  implant: {
    name: 'イオン注入装置', short: 'IMP', accent: '#3f9a96',
    w: 3, h: 2, cost: 6000, procTime: 5, baseDefect: 0.008, wear: 0.02, placeable: true,
    category: 'thermal',
    desc: '不純物イオンを打ち込みトランジスタを形成する(FEOL専用)。高価だが清浄で欠陥が少ない',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  ald: {
    name: 'ALD装置', short: 'ALD', accent: '#4f9a7a',
    w: 2, h: 2, cost: 15000, procTime: 4, baseDefect: 0.01, wear: 0.03, placeable: true,
    category: 'thermal',
    desc: '原子層堆積。45nm以降のHKMG(高誘電率ゲート絶縁膜)形成に必須の新工程',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  metal: {
    name: 'メタル成膜装置', short: 'PVD', accent: '#b06a9a',
    w: 2, h: 2, cost: 3500, procTime: 3, baseDefect: 0.015, wear: 0.03, placeable: true,
    serves: 'metal', category: 'beol',
    desc: 'Alスパッタで配線金属を成膜する(BEOL)。65nmまでの配線に使える',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  cu: {
    name: 'Cuめっき装置', short: 'ECD', accent: '#c78a4f',
    w: 2, h: 2, cost: 12000, procTime: 3, baseDefect: 0.012, wear: 0.035, placeable: true,
    serves: 'metal', category: 'beol',
    desc: '電解銅めっき(ECD)。45nm以降の微細配線はAlでは不可でこれが必須。全世代の配線に使える',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  cmp: {
    name: 'CMP装置', short: 'CMP', accent: '#8d6e5c',
    w: 2, h: 2, cost: 4000, procTime: 3, baseDefect: 0.02, wear: 0.06, placeable: true,
    category: 'beol',
    desc: 'ウェハ表面を研磨して平坦化する。配線層ごとに再訪するBEOLの要衝。スラリーで最も汚れやすい',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  inspect: {
    name: '検査装置', short: 'INS', accent: '#6aa86e',
    w: 2, h: 1, cost: 1500, procTime: 2, baseDefect: 0, wear: 0.01, placeable: true,
    category: 'logistics',
    desc: '最終検査。歩留まりが確定し、低すぎるロットは廃棄される',
    ports: [{ dx: 0, dy: 0, io: 'in' }, { dx: 1, dy: 0, io: 'out' }],
  },
  stocker: {
    name: 'ストッカー', short: 'STK', accent: '#7887a0',
    w: 2, h: 2, cost: 1200, procTime: 0, baseDefect: 0, wear: 0, placeable: true,
    category: 'logistics',
    desc: 'FOUPの自動倉庫。行き先が満杯のロットを退避させ、詰まり(デッドロック)を防ぐ',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
  },
  ship: {
    name: '出荷ステーション', short: '出荷', accent: '#78909c',
    w: 2, h: 2, cost: 2000, procTime: 0, baseDefect: 0, wear: 0, placeable: true,
    category: 'station',
    desc: '完成ロットの搬出先。複数設置でき、最寄りへ搬送される',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'in' }],
  },
};

// 露光装置kindの一覧(ティア昇順)
export const LITHO_KINDS: MachineKind[] = ['litho', 'krf', 'arf', 'euv', 'euvhna'];

export function lithoTierOf(kind: MachineKind): number {
  return MACHINE_DEFS[kind].lithoTier ?? -1;
}

// ---- 製品と工程レシピ ----
export interface RecipeStep {
  kind: MachineKind;
  label: string;
}

export type ProductId =
  | 'diode' | 'logic' | 'power' | 'imgsensor' | 'dram' | 'flash' | 'cpu' | 'gpu';

export interface Product {
  id: ProductId;
  name: string;
  color: string;      // FOUPタグ・UIの識別色(固定順の categorical)
  price: number;      // 出荷基準単価 [¥/ロット](gen0基準)。実売上は 単価×ノード倍率×鮮度×歩留まり
  waferCost: number;  // 投入時に支払うウェハ原価 [¥/ロット](gen0基準)
  research: number;   // 製品研究費 [¥]。0 は初期解禁
  requires: ProductId[]; // 前提となる研究済み製品
  reqNode: number;    // 研究/生産に必要な最低ノード世代(gen)
  freshFloor: number; // この製品の鮮度の下限(高いほど成熟ノードでも稼げる)
  steps: RecipeStep[];
}

const s = (kind: MachineKind, label: string): RecipeStep => ({ kind, label });

// レシピはFEOL→(モジュール工程)→BEOL→検査の構造。製品ごとに工程の
// 配合比が違うので、混流するとボトルネックの位置が製品ミックスで変わる:
//  - パワーMOSFET: 炉・注入が中心で露光が少ない(BEOLもCMP不要)
//  - フラッシュ: 成膜・エッチの繰り返しが極端に多い(注入なし)
//  - CPU/GPU: 露光・CMPの再訪が最多
export const PRODUCTS: Record<ProductId, Product> = {
  diode: {
    id: 'diode', name: 'ダイオード', color: '#3f8f7a',
    price: 500, waferCost: 120, research: 0, requires: [], reqNode: 0, freshFloor: 0.6,
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
    id: 'logic', name: 'ロジックIC', color: '#4a7dbb',
    price: 1300, waferCost: 300, research: 5000, requires: [], reqNode: 0, freshFloor: 0.55,
    steps: [
      s('clean', '初期洗浄'),
      s('furnace', '酸化'),
      s('litho', '露光 (ゲート)'),
      s('etch', 'エッチング (ゲート)'),
      s('implant', '注入'),
      s('furnace', 'アニール'),
      s('depo', '成膜 (層間膜)'),
      s('litho', '露光 (配線)'),
      s('etch', 'エッチング (配線)'),
      s('metal', 'メタル成膜'),
      s('cmp', 'CMP平坦化'),
      s('inspect', '検査'),
    ],
  },
  power: {
    id: 'power', name: 'パワーMOSFET', color: '#96833b',
    price: 1600, waferCost: 350, research: 10000, requires: ['logic'], reqNode: 0, freshFloor: 0.65,
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
  imgsensor: {
    id: 'imgsensor', name: 'イメージセンサ', color: '#3f9ab0',
    price: 2000, waferCost: 420, research: 12000, requires: ['logic'], reqNode: 2, freshFloor: 0.7,
    steps: [
      // フォトダイオードアレイ(注入・成膜が多い)
      s('clean', '初期洗浄'),
      s('furnace', '酸化'),
      s('litho', '露光 (画素)'),
      s('etch', 'エッチング (画素)'),
      s('implant', '注入 (フォトダイオード)'),
      s('furnace', 'アニール'),
      s('litho', '露光 (転送ゲート)'),
      s('etch', 'エッチング (転送ゲート)'),
      s('implant', '注入 (FD)'),
      // 配線
      s('depo', '成膜 (層間膜)'),
      s('litho', '露光 (配線)'),
      s('etch', 'エッチング (配線)'),
      s('metal', 'メタル成膜'),
      s('cmp', 'CMP平坦化'),
      // カラーフィルタ/マイクロレンズ(成膜)
      s('depo', '成膜 (カラーフィルタ)'),
      s('depo', '成膜 (マイクロレンズ)'),
      s('inspect', '検査'),
    ],
  },
  dram: {
    id: 'dram', name: 'DRAM', color: '#b05fa3',
    price: 2400, waferCost: 550, research: 20000, requires: ['logic'], reqNode: 2, freshFloor: 0.55,
    steps: [
      s('clean', '初期洗浄'),
      s('furnace', '酸化'),
      s('litho', '露光 (ゲート)'),
      s('etch', 'エッチング (ゲート)'),
      s('implant', '注入'),
      s('furnace', 'アニール'),
      s('depo', '成膜 (キャパシタ)'),
      s('litho', '露光 (キャパシタ)'),
      s('etch', 'エッチング (キャパシタ)'),
      s('furnace', 'アニール (high-k)'),
      s('depo', '成膜 (層間膜)'),
      s('litho', '露光 (配線)'),
      s('etch', 'エッチング (配線)'),
      s('metal', 'メタル成膜'),
      s('cmp', 'CMP平坦化'),
      s('inspect', '検査'),
    ],
  },
  flash: {
    id: 'flash', name: 'フラッシュメモリ', color: '#6a5ac2',
    price: 2800, waferCost: 650, research: 30000, requires: ['dram'], reqNode: 3, freshFloor: 0.55,
    steps: [
      s('clean', '初期洗浄'),
      s('depo', '成膜 (積層 ①)'),
      s('depo', '成膜 (積層 ②)'),
      s('depo', '成膜 (積層 ③)'),
      s('litho', '露光 (チャネル)'),
      s('etch', 'エッチング (深穴 ①)'),
      s('etch', 'エッチング (深穴 ②)'),
      s('depo', '成膜 (チャネル)'),
      s('furnace', 'アニール'),
      s('depo', '成膜 (層間膜)'),
      s('litho', '露光 (配線)'),
      s('etch', 'エッチング (配線)'),
      s('metal', 'メタル成膜'),
      s('cmp', 'CMP平坦化'),
      s('inspect', '検査'),
    ],
  },
  cpu: {
    id: 'cpu', name: 'CPU', color: '#c26b3d',
    price: 4000, waferCost: 900, research: 50000, requires: ['dram'], reqNode: 3, freshFloor: 0.5,
    steps: [
      s('clean', '初期洗浄'),
      s('furnace', '酸化'),
      s('implant', '注入 (ウェル)'),
      s('litho', '露光 (ゲート)'),
      s('etch', 'エッチング (ゲート)'),
      s('implant', '注入 (S/D)'),
      s('furnace', 'アニール'),
      s('clean', '中間洗浄'),
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
  gpu: {
    id: 'gpu', name: 'GPU / AIアクセラレータ', color: '#c23d6b',
    price: 6500, waferCost: 1400, research: 120000, requires: ['cpu'], reqNode: 10, freshFloor: 0.5,
    steps: [
      s('clean', '初期洗浄'),
      s('furnace', '酸化'),
      s('implant', '注入 (ウェル)'),
      s('litho', '露光 (ゲート)'),
      s('etch', 'エッチング (ゲート)'),
      s('implant', '注入 (S/D)'),
      s('furnace', 'アニール'),
      s('clean', '中間洗浄'),
      // BEOL 3層(高密度配線)
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
      s('depo', '成膜 (層間膜 ③)'),
      s('litho', '露光 (配線 ③)'),
      s('etch', 'エッチング (配線 ③)'),
      s('metal', 'メタル成膜 ③'),
      s('cmp', 'CMP平坦化 ③'),
      s('inspect', '検査'),
    ],
  },
};

export const PRODUCT_ORDER: ProductId[] =
  ['diode', 'logic', 'power', 'imgsensor', 'dram', 'flash', 'cpu', 'gpu'];

// ---- プロセスノード(微細化)----
// ノードは技術ツリーで研究して解禁する。研究済みノードは全製品で生産に使える。
// ノードが進むほど: 配線層が増え(約3世代ごとに+1層)、節目でFEOL工程(ALD/
// FinFET/GAA)が加わり、微細な露光はマルチパターニングや上位露光機を要求する。
export interface NodeDef {
  gen: number;
  label: string;
  research: number;    // 研究費 [¥]。0 は初期解禁(250nm)
  researchTime: number;// 研究所要 [秒](シミュ時間)
  priceMul: number;    // 出荷単価の世代倍率(先端ほど高い)
  addLayers: number;   // 基本レシピに追加する配線(ダマシン)層の数
}

// 露光ティアごとの単パターン限界(single)とMP絶対限界(mp)を gen で表す。
// gen が single 以下なら1回露光、single超〜mp以下ならマルチパターニング(複数回)、
// mp超はそのティアでは物理的に不可能(上位露光機が必須)
const LITHO_LIMITS: { single: number; mp: number }[] = [
  { single: 1, mp: 2 },    // 0 i線:  180nm単, 130nm MP
  { single: 3, mp: 4 },    // 1 KrF:  90nm単,  65nm MP
  { single: 6, mp: 10 },   // 2 ArFi: 32nm単,  22〜7nm MP
  { single: 11, mp: 13 },  // 3 EUV:  5nm単,   3〜2nm MP
  { single: 13, mp: 13 },  // 4 hNA:  2nm単
];

export const NODE_DEFS: NodeDef[] = [
  { gen: 0,  label: '250nm', research: 0,       researchTime: 0,   priceMul: 1.00, addLayers: 0 },
  { gen: 1,  label: '180nm', research: 8000,    researchTime: 55,  priceMul: 1.30, addLayers: 0 },
  { gen: 2,  label: '130nm', research: 14000,   researchTime: 70,  priceMul: 1.70, addLayers: 1 },
  { gen: 3,  label: '90nm',  research: 24000,   researchTime: 90,  priceMul: 2.20, addLayers: 1 },
  { gen: 4,  label: '65nm',  research: 40000,   researchTime: 110, priceMul: 2.90, addLayers: 1 },
  { gen: 5,  label: '45nm',  research: 70000,   researchTime: 130, priceMul: 3.80, addLayers: 2 },
  { gen: 6,  label: '32nm',  research: 120000,  researchTime: 150, priceMul: 5.00, addLayers: 2 },
  { gen: 7,  label: '22nm',  research: 200000,  researchTime: 175, priceMul: 6.60, addLayers: 2 },
  { gen: 8,  label: '14nm',  research: 340000,  researchTime: 200, priceMul: 8.70, addLayers: 3 },
  { gen: 9,  label: '10nm',  research: 560000,  researchTime: 225, priceMul: 11.5, addLayers: 3 },
  { gen: 10, label: '7nm',   research: 900000,  researchTime: 250, priceMul: 15.0, addLayers: 3 },
  { gen: 11, label: '5nm',   research: 1500000, researchTime: 280, priceMul: 20.0, addLayers: 4 },
  { gen: 12, label: '3nm',   research: 2500000, researchTime: 310, priceMul: 26.0, addLayers: 4 },
  { gen: 13, label: '2nm',   research: 4000000, researchTime: 340, priceMul: 34.0, addLayers: 4 },
];

export const MAX_GEN = NODE_DEFS.length - 1;
export const PROCESS_NODES = NODE_DEFS.map((n) => n.label);

export function nodeLabel(gen: number): string {
  return NODE_DEFS[Math.max(0, Math.min(gen, MAX_GEN))].label;
}

export function nodePriceMul(gen: number): number {
  return NODE_DEFS[Math.max(0, Math.min(gen, MAX_GEN))].priceMul;
}

// 露光: gen を露光ティア tier で処理するのに必要な露光回数。
// 不可能なら Infinity(そのティアでは物理的に露光できない)
export function lithoPasses(tier: number, gen: number): number {
  const L = LITHO_LIMITS[tier];
  if (!L) return Infinity;
  if (gen <= L.single) return 1;
  if (gen <= L.mp) {
    const span = L.mp - L.single;
    const pos = gen - L.single; // 1..span
    return Math.min(4, 2 + Math.floor(((pos - 1) * 3) / Math.max(1, span - 1)));
  }
  return Infinity;
}

// そのノードを露光できる最低ティア(MP込み)
export function minLithoTier(gen: number): number {
  for (let t = 0; t < LITHO_LIMITS.length; t++) {
    if (Number.isFinite(lithoPasses(t, gen))) return t;
  }
  return LITHO_LIMITS.length - 1;
}

// そのノードを単パターン(1回露光)で処理できる最低ティア
export function singleLithoTier(gen: number): number {
  for (let t = 0; t < LITHO_LIMITS.length; t++) {
    if (lithoPasses(t, gen) === 1) return t;
  }
  return LITHO_LIMITS.length - 1;
}

// 45nm以降のBEOL配線はCuめっき(ECD)が必須(Alスパッタでは不可)
export function metalNeedsCu(gen: number): boolean {
  return gen >= 5;
}

// ---- レシピ生成(世代・露光ティアを織り込む)----
// gen=0 の基本レシピを土台に:
//  1. 節目のFEOL工程(45nm:ALDゲート絶縁膜 / 22nm:FinFET / 3nm:GAA)を挿入
//  2. addLayers ぶんのダマシン配線層(成膜→露光→エッチ→メタル→CMP)を検査直前に追加
//  3. 露光ティアに応じ露光工程をマルチパターニング展開(litho×N + 中間エッチ)
function damasceneLayer(i: number): RecipeStep[] {
  return [
    s('depo', `成膜 (追加配線層${i})`),
    s('litho', `露光 (追加配線層${i})`),
    s('etch', `エッチング (追加配線層${i})`),
    s('metal', `メタル成膜 (追加配線層${i})`),
    s('cmp', `CMP (追加配線層${i})`),
  ];
}

// 露光ティアで litho ステップを展開。単パターンならそのまま、MPなら
// litho→エッチを passes 回繰り返す(パターン分割の実体)
function expandLitho(step: RecipeStep, gen: number, expoTier: number): RecipeStep[] {
  const passes = lithoPasses(expoTier, gen);
  if (!Number.isFinite(passes) || passes <= 1) return [step];
  const out: RecipeStep[] = [];
  for (let p = 1; p <= passes; p++) {
    out.push(s('litho', `${step.label} MP${p}/${passes}`));
    out.push(s('etch', `パターン分割エッチ ${p}/${passes}`));
  }
  return out;
}

export function stepsForGen(product: ProductId, gen: number, expoTier?: number): RecipeStep[] {
  const base = PRODUCTS[product].steps;
  const g = Math.max(0, Math.min(gen, MAX_GEN));
  const tier = expoTier ?? singleLithoTier(g);

  // 1. 土台をクローンし、節目のFEOL工程を最初の炉(酸化)直後へ挿入
  let steps = base.slice();
  const feol: RecipeStep[] = [];
  if (g >= 5) feol.push(s('ald', 'ゲート絶縁膜ALD (HKMG)'));
  if (g >= 7) feol.push(s('depo', 'フィン形成 成膜'), s('etch', 'フィン形成 エッチ'));
  if (g >= 12) feol.push(s('depo', 'ナノシート 成膜'), s('etch', 'ナノシート エッチ'));
  if (feol.length > 0) {
    let anchor = steps.findIndex((st) => st.kind === 'furnace');
    if (anchor < 0) anchor = 0; // 炉が無い製品は先頭直後へ
    steps = [...steps.slice(0, anchor + 1), ...feol, ...steps.slice(anchor + 1)];
  }

  // 2. 追加配線層を検査(最終工程)の直前へ
  const layers = NODE_DEFS[g].addLayers;
  if (layers > 0) {
    const extra: RecipeStep[] = [];
    for (let i = 1; i <= layers; i++) extra.push(...damasceneLayer(i));
    steps = [...steps.slice(0, -1), ...extra, steps[steps.length - 1]];
  }

  // 3. 露光工程のマルチパターニング展開
  const expanded: RecipeStep[] = [];
  for (const st of steps) {
    if (st.kind === 'litho') expanded.push(...expandLitho(st, g, tier));
    else expanded.push(st);
  }
  return expanded;
}

// gen/tier を明示しない呼び出しは基本ノード(gen=0)として扱う
export function stepsOf(product: ProductId, gen = 0, expoTier?: number): RecipeStep[] {
  return stepsForGen(product, gen, expoTier);
}

// ---- レシピの省略表示 ----
// 長いレシピを、繰り返し部分を「×N」に畳んで読みやすくする。
// 隣接する同一(kind,label)の連続と、周期的に繰り返すブロックを検出する。
export interface CompactStep {
  step: RecipeStep;
  count: number;     // この行が表す原ステップ数(ブロック内合計)
  block?: RecipeStep[]; // 2ステップ以上の繰り返しブロックのとき、その1周期
  repeat: number;    // 繰り返し回数(1なら非繰り返し)
  from: number;      // 元レシピでの開始インデックス(0基点)
}

// ラベルの通し番号(①/1/2…)を無視して繰り返しを検出するための正規化
function normLabel(label: string): string {
  return label
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩]/g, '#')
    .replace(/\d+/g, '#')
    .trim();
}

function stepKey(st: RecipeStep): string {
  return `${st.kind}:${normLabel(st.label)}`;
}

export function compactSteps(steps: RecipeStep[]): CompactStep[] {
  const out: CompactStep[] = [];
  let i = 0;
  while (i < steps.length) {
    // 周期 p の繰り返しブロックを大きい方から探す(最大周期6)
    let found: { p: number; reps: number } | null = null;
    for (let p = Math.min(6, Math.floor((steps.length - i) / 2)); p >= 2; p--) {
      let reps = 1;
      while (
        i + (reps + 1) * p <= steps.length &&
        blockEq(steps, i, i + reps * p, p)
      ) {
        reps++;
      }
      if (reps >= 2) {
        found = { p, reps };
        break;
      }
    }
    if (found) {
      const block = steps.slice(i, i + found.p);
      out.push({
        step: block[0], count: found.p * found.reps,
        block, repeat: found.reps, from: i,
      });
      i += found.p * found.reps;
      continue;
    }
    // 単一ステップの連続(同一 kind+正規化ラベル)
    let reps = 1;
    while (i + reps < steps.length && stepKey(steps[i + reps]) === stepKey(steps[i])) reps++;
    out.push({ step: steps[i], count: reps, repeat: reps, from: i });
    i += reps;
  }
  return out;
}

function blockEq(steps: RecipeStep[], a: number, b: number, p: number): boolean {
  for (let k = 0; k < p; k++) {
    if (stepKey(steps[a + k]) !== stepKey(steps[b + k])) return false;
  }
  return true;
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
// コスト制約。収入は出荷売上のみ: 基準単価 × ノード倍率 × 鮮度 × 歩留まり
export const START_MONEY = 30000;
export const OHT_COST = 2000;         // OHTビークル1台の購入価格
export const RAIL_COST = 25;          // レール1区間(エッジ)あたりの敷設費
export const SELL_RATIO = 0.5;        // 装置撤去・OHT売却・レール撤去の払い戻し率

// 先端ノードは希少で高価格、成熟(自分が量産)するほど値崩れする。
// 鮮度 = floor + (1-floor)*exp(-出荷数/FRESH_TAU)。floorは製品ごと(Product.freshFloor)
export const FRESH_TAU = 30;

// 歩留まり学習曲線(yield ramp): 新ノード立ち上げ直後は欠陥が多く、そのノードでの
// 累計生産が増えるほど改善する。ノード単位でファブ共通(製品を変えても引き継ぐ)。
// 欠陥倍率 = 1 + LEARN_PENALTY*exp(-ノード累計完成数/LEARN_TAU)
export const LEARN_PENALTY = 0.8;
export const LEARN_TAU = 25;

// ---- シミュレーション定数 ----
export const UTIL_TAU = 45;           // 装置稼働率EMAの時定数 [秒]
export const MIN_CLEANLINESS = 0.2;
export const SCRAP_THRESHOLD = 0.4;   // 検査でこれ未満は廃棄
export const YIELD_WINDOW = 30;       // 平均歩留まりの移動平均サンプル数(直近完成ロット)
export const DEFAULT_SPAWN_INTERVAL = 10;
export const STOCKER_CAP = 6;         // ストッカーの内部保管数
export const FURNACE_BATCH = 3;       // 拡散炉の同時処理ロット数
export const FURNACE_WAIT = 10;       // 満載を待つ最大時間 [秒](超えたら装填分だけで処理開始)

// ---- 自動メンテナンス(PM: 予防保全)----
// 故障とランダム停止は廃止。清浄度が閾値を下回ったら、ジョブ完了後に自動で
// 短時間の整備に入り(クリック不要)、清浄度が全回復する。CMPのように汚れやすい
// 装置は自然にPM頻度が高く=実効能力が低い、という個性が数字として残る
export const PM_THRESHOLD = 0.5;      // この清浄度を下回るとジョブ後に自動整備
export const PM_TIME = 15;            // 整備所要 [秒]

// ---- セーブ ----
export const SAVE_KEY = 'semifab.save.v1';
// v5: 微細化をユーザ主導の技術ツリー化、露光/メタル/ALDの装置ティア拡張、
// 故障→自動PM、投入/搬出の複数設置。レシピ体系が変わるため旧セーブの
// 仕掛かりロットは破棄する(工場・資金・研究進捗は維持)
export const SAVE_VERSION = 5;
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
export const MAX_FLEET = 24; // 複数ライン・長工程化に合わせて拡大
