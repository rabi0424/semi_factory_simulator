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
    desc: '回路パターンを転写する。工場最大の装置で、レシピ中2回通る要衝',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 2, dy: 1, io: 'out' }],
  },
  etch: {
    name: 'エッチング装置', short: 'ETCH', accent: '#c77e4f',
    w: 2, h: 2, procTime: 3, baseDefect: 0.02, wear: 0.035, placeable: true,
    desc: 'パターンに沿って膜を削る',
    ports: [{ dx: 0, dy: 1, io: 'in' }, { dx: 1, dy: 1, io: 'out' }],
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

// ---- 工程レシピ(リエントラント: 成膜・露光・エッチングを2周) ----
export interface RecipeStep {
  kind: MachineKind;
  label: string;
}

export const RECIPE: RecipeStep[] = [
  { kind: 'clean',   label: '初期洗浄' },
  { kind: 'depo',    label: '成膜 ①' },
  { kind: 'litho',   label: '露光 ①' },
  { kind: 'etch',    label: 'エッチング ①' },
  { kind: 'depo',    label: '成膜 ②' },
  { kind: 'litho',   label: '露光 ②' },
  { kind: 'etch',    label: 'エッチング ②' },
  { kind: 'clean',   label: '最終洗浄' },
  { kind: 'inspect', label: '検査' },
];

// ---- シミュレーション定数 ----
export const MAINT_TIME = 8;          // メンテナンス所要 [秒]
export const MIN_CLEANLINESS = 0.2;
export const SCRAP_THRESHOLD = 0.4;   // 検査でこれ未満は廃棄
export const DEFAULT_SPAWN_INTERVAL = 10;
export const STOCKER_CAP = 6;         // ストッカーの内部保管数

// ---- OHT(天井搬送) ----
export const OHT_SPEED = 6;           // 走行速度 [タイル/秒]
export const OHT_IDLE_SPEED = 5;      // 空走(巡回)速度。遅すぎると後続の実車を塞ぐ
export const HOIST_TIME = 0.5;        // 吊り上げ/下ろし片道 [秒]
export const START_FLEET = 3;
export const MAX_FLEET = 12;
