// マップ・タイル設定
export const TILE = 56;
export const COLS = 14;
export const ROWS = 10;

// 装置の種類
export type MachineKind =
  | 'load'    // 投入口(ロット生成)
  | 'clean'   // 洗浄
  | 'depo'    // 成膜
  | 'litho'   // 露光
  | 'etch'    // エッチング
  | 'inspect' // 検査
  | 'ship';   // 出荷口

export interface MachineDef {
  name: string;      // 表示名
  short: string;     // 盤面上の短縮表示(2文字)
  color: string;
  procTime: number;  // 処理時間 [秒]
  baseDefect: number;// 1工程あたりの基礎欠陥率(歩留まり低下量)
  wear: number;      // 1ジョブごとの清浄度低下量
  placeable: boolean;
  desc: string;
}

export const MACHINE_DEFS: Record<MachineKind, MachineDef> = {
  load: {
    name: '投入口', short: '投入', color: '#90a4ae',
    procTime: 0, baseDefect: 0, wear: 0, placeable: false,
    desc: '新しいロット(FOUP)がここから投入される',
  },
  clean: {
    name: '洗浄装置', short: '洗浄', color: '#4fc3f7',
    procTime: 2, baseDefect: 0.005, wear: 0.02, placeable: true,
    desc: 'ウェハ表面を洗浄する。速くて汚れにくい',
  },
  depo: {
    name: '成膜装置', short: '成膜', color: '#b388ff',
    procTime: 3, baseDefect: 0.02, wear: 0.035, placeable: true,
    desc: '薄膜を堆積させる。使うほど汚れる',
  },
  litho: {
    name: '露光装置', short: '露光', color: '#ffd54f',
    procTime: 4, baseDefect: 0.025, wear: 0.03, placeable: true,
    desc: '回路パターンを転写する。レシピ中2回使う要衝(ボトルネック)',
  },
  etch: {
    name: 'エッチング装置', short: 'ｴｯﾁ', color: '#ff8a65',
    procTime: 3, baseDefect: 0.02, wear: 0.035, placeable: true,
    desc: 'パターンに沿って膜を削る',
  },
  inspect: {
    name: '検査装置', short: '検査', color: '#81c784',
    procTime: 2, baseDefect: 0, wear: 0.01, placeable: true,
    desc: '最終検査。歩留まりが確定し、低すぎるロットは廃棄される',
  },
  ship: {
    name: '出荷口', short: '出荷', color: '#90a4ae',
    procTime: 0, baseDefect: 0, wear: 0, placeable: false,
    desc: '完成したロットの搬出先',
  },
};

// プロセスフロー(工程レシピ)。露光・エッチング・成膜を再訪する
// リエントラントフローが最小構成で入っている
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

// シミュレーション定数
export const QUEUE_CAP = 3;          // 装置1台あたりの待機スロット数
export const MAINT_TIME = 8;         // メンテナンス所要時間 [秒]
export const MIN_CLEANLINESS = 0.2;  // 清浄度の下限
export const SCRAP_THRESHOLD = 0.4;  // これ未満の歩留まりは検査で廃棄
export const LOT_SPEED = 140;        // ロット移動速度 [px/秒]
export const WIP_CAP = 20;           // 仕掛かりロット数の上限
export const DEFAULT_SPAWN_INTERVAL = 6; // ロット投入間隔 [秒]
