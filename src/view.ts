// 描画層とUIが共有するビュー状態(3D/2D非依存)

import type { MachineKind } from './config';
import type { Machine } from './sim';
import type { TileKey } from './rail';

export type ToolMode = 'select' | 'rail' | 'railErase' | 'place' | 'demolish';

export interface Tool {
  mode: ToolMode;
  kind: MachineKind | null; // place のとき
}

export interface ViewState {
  cursor: { c: number; r: number; inside: boolean };
  tool: Tool;
  toolRot: number;       // 設置ツールの回転(Rキー)
  railPath: TileKey[];   // レール敷設ドラッグ中のプレビュー経路
  selected: Machine | null;
  highlightKind: MachineKind | null; // 工程フローパネルで選んだ装置種(フロア連動ハイライト)
  showHeat: boolean;     // 渋滞ヒートマップ表示
  time: number;
}
