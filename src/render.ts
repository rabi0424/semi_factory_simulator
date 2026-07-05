// クリーンルーム調のワールド描画。
// 床(パンチングパネル) → 装置(2.5D) → 天井レール → OHTビークルの順に重ねる。

import { TILE, MAP_COLS, MAP_ROWS, MACHINE_DEFS } from './config';
import type { MachineKind } from './config';
import { parseKey, tkey } from './rail';
import type { TileKey } from './rail';
import { Game } from './sim';
import type { Machine } from './sim';
import { vehiclePos } from './oht';
import type { Vehicle } from './oht';

export interface Camera {
  x: number;      // ワールド座標(左上)
  y: number;
  scale: number;
}

export type ToolMode = 'select' | 'rail' | 'railErase' | 'place' | 'demolish';

export interface Tool {
  mode: ToolMode;
  kind: MachineKind | null; // place のとき
}

export interface ViewState {
  cam: Camera;
  cursor: { c: number; r: number; inside: boolean };
  tool: Tool;
  railPath: TileKey[];   // レール敷設ドラッグ中のプレビュー経路
  selected: Machine | null;
  time: number;
}

// ---- パレット ----
const C = {
  outside: '#dce1e4',
  floor: '#f2f4f6',
  floorDot: '#e0e6e9',
  floorLine: '#e9edef',
  bodyTop: '#fbfcfd',
  bodySide: '#d5dbdf',
  bodyEdge: '#c2ccd2',
  seam: '#e6ebee',
  shadow: 'rgba(70, 90, 100, 0.10)',
  ink: '#37444c',
  dim: '#7a8892',
  railCasing: '#aab4bb',
  railInner: '#f0f3f4',
  railShadow: 'rgba(70, 90, 100, 0.08)',
  chevron: '#66727c',
  vehicleBody: '#f7f9fa',
  vehicleEdge: '#98a3ab',
  foup: 'rgba(133, 106, 178, 0.90)',
  foupLid: 'rgba(206, 192, 228, 0.95)',
  foupEdge: 'rgba(84, 64, 122, 0.55)',
  ok: '#3f9c5a',
  warn: '#d99a2b',
  bad: '#cc4f44',
  accent: '#7761a7',
};

const LIFT2 = 12; // 高さ表現(2タイル奥行きの装置)
const LIFT1 = 8;  // 同(1タイル奥行き)

let floorPattern: CanvasPattern | null = null;

function ensureFloorPattern(ctx: CanvasRenderingContext2D) {
  if (floorPattern) return;
  const c = document.createElement('canvas');
  c.width = TILE;
  c.height = TILE;
  const p = c.getContext('2d')!;
  p.fillStyle = C.floor;
  p.fillRect(0, 0, TILE, TILE);
  // パンチングパネル風の孔
  p.fillStyle = C.floorDot;
  const n = 4;
  const gap = TILE / n;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      p.beginPath();
      p.arc(gap / 2 + i * gap, gap / 2 + j * gap, 1.6, 0, Math.PI * 2);
      p.fill();
    }
  }
  // タイル目地
  p.strokeStyle = C.floorLine;
  p.lineWidth = 1;
  p.strokeRect(0.5, 0.5, TILE - 1, TILE - 1);
  floorPattern = ctx.createPattern(c, 'repeat');
}

export function render(
  ctx: CanvasRenderingContext2D,
  game: Game,
  vs: ViewState,
  cssW: number,
  cssH: number,
  dpr: number,
) {
  ensureFloorPattern(ctx);
  const { cam } = vs;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.outside;
  ctx.fillRect(0, 0, cssW, cssH);

  ctx.setTransform(
    dpr * cam.scale, 0, 0, dpr * cam.scale,
    -cam.x * cam.scale * dpr, -cam.y * cam.scale * dpr,
  );

  // 床
  ctx.fillStyle = floorPattern!;
  ctx.fillRect(0, 0, MAP_COLS * TILE, MAP_ROWS * TILE);
  ctx.strokeStyle = '#c8d1d6';
  ctx.lineWidth = 2;
  ctx.strokeRect(0, 0, MAP_COLS * TILE, MAP_ROWS * TILE);

  // 装置(奥→手前)
  const sorted = [...game.machines].sort((a, b) => a.row - b.row);
  for (const m of sorted) drawMachine(ctx, m, vs);

  // 天井レール
  drawRails(ctx, game, vs);

  // OHTビークル
  for (const v of game.fleet.vehicles) drawVehicle(ctx, v, vs.time);

  // ツールのオーバーレイ
  drawOverlays(ctx, game, vs);
}

// ---- 装置 ----

function drawMachine(ctx: CanvasRenderingContext2D, m: Machine, vs: ViewState) {
  const def = MACHINE_DEFS[m.kind];
  const lift = def.h === 1 ? LIFT1 : LIFT2;
  const x = m.col * TILE;
  const y = m.row * TILE;
  const W = def.w * TILE;
  const H = def.h * TILE;
  const i = 3;

  // 接地影
  ctx.fillStyle = C.shadow;
  ctx.fillRect(x + i + 4, y + i + 5, W - i * 2, H - i * 2);

  // 側面(南面)
  ctx.fillStyle = C.bodySide;
  ctx.fillRect(x + i, y + H - i - lift, W - i * 2, lift);
  ctx.strokeStyle = C.bodyEdge;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + i + 0.5, y + H - i - lift + 0.5, W - i * 2 - 1, lift - 1);

  // 天面
  const ty = y + i - lift;
  const th = H - i * 2;
  ctx.fillStyle = C.bodyTop;
  ctx.fillRect(x + i, ty, W - i * 2, th);
  ctx.strokeStyle = C.bodyEdge;
  ctx.strokeRect(x + i + 0.5, ty + 0.5, W - i * 2 - 1, th - 1);

  // パネル分割線
  ctx.strokeStyle = C.seam;
  ctx.beginPath();
  for (let s = 1; s < def.w; s++) {
    ctx.moveTo(x + s * TILE + 0.5, ty + 4);
    ctx.lineTo(x + s * TILE + 0.5, ty + th - 4);
  }
  ctx.stroke();

  // アクセントライン(天面の南端)
  ctx.fillStyle = def.accent;
  ctx.fillRect(x + i + 1, ty + th - 5, W - i * 2 - 2, 4);

  // 銘板
  ctx.fillStyle = C.ink;
  ctx.font = `600 10px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(m.label, x + i + 6, ty + 6);

  // ストッカーは内部棚のFOUPを天面に見せる
  if (m.kind === 'stocker') {
    ctx.fillStyle = C.dim;
    ctx.font = '600 9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(`${m.storage.length}/6`, x + W - i - 6, ty + 6);
    for (let s = 0; s < m.storage.length; s++) {
      const sx = x + i + 16 + (s % 3) * 22;
      const sy = ty + 34 + Math.floor(s / 3) * 20;
      drawFoup(ctx, sx, sy);
    }
  }

  // 清浄度ゲージ(細線)
  if (def.placeable && m.kind !== 'stocker') {
    const gw = 34;
    const gx = x + i + 6;
    const gy = ty + 20;
    ctx.fillStyle = '#e6ebee';
    ctx.fillRect(gx, gy, gw, 3);
    const c = m.cleanliness;
    ctx.fillStyle = c > 0.6 ? C.ok : c > 0.35 ? C.warn : C.bad;
    ctx.fillRect(gx, gy, gw * c, 3);
  }

  // 処理進捗
  if (m.busyLot) {
    const p = 1 - m.procLeft / def.procTime;
    ctx.fillStyle = '#e6ebee';
    ctx.fillRect(x + i + 6, ty + th - 12, W - i * 2 - 12, 3);
    ctx.fillStyle = def.accent;
    ctx.fillRect(x + i + 6, ty + th - 12, (W - i * 2 - 12) * p, 3);
  }

  // シグナルタワー(積層灯)。投入・出荷ステーションには不要
  if (def.placeable) drawStackLight(ctx, x + W - i - 10, ty + 5, m);

  // ロードポート
  for (const p of m.ports) {
    const px = (p.col + 0.5) * TILE;
    const py = y + H - i;
    // ドック台座
    ctx.fillStyle = '#cdd5da';
    ctx.strokeStyle = p.reserved ? C.accent : '#b3bdc4';
    ctx.lineWidth = 1;
    rr(ctx, px - 13, py - 5, 26, 15, 2);
    ctx.fill();
    ctx.stroke();
    // 入出マーカー
    ctx.fillStyle = C.dim;
    ctx.beginPath();
    if (p.io === 'in') {
      ctx.moveTo(px - 3, py + 8);
      ctx.lineTo(px + 3, py + 8);
      ctx.lineTo(px, py + 4);
    } else {
      ctx.moveTo(px - 3, py + 4);
      ctx.lineTo(px + 3, py + 4);
      ctx.lineTo(px, py + 8);
    }
    ctx.fill();
    if (p.foup) drawFoup(ctx, px, py - 1);
  }

  // 搬送経路なし警告
  if (m.noRoute) {
    const blink = Math.sin(vs.time * 5) > -0.3;
    if (blink) {
      const bx = x + W / 2;
      const by = ty - 8;
      ctx.beginPath();
      ctx.arc(bx, by, 7, 0, Math.PI * 2);
      ctx.fillStyle = C.warn;
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', bx, by + 0.5);
    }
  }
}

function drawStackLight(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  m: Machine,
) {
  const isStocker = m.kind === 'stocker';
  const full = isStocker && m.storage.length >= 6;
  const states = isStocker
    ? [
        { color: C.bad, on: full },
        { color: C.warn, on: false },
        { color: C.ok, on: !full },
      ]
    : [
        { color: C.bad, on: m.maintLeft > 0 || m.holdLot !== null },
        { color: C.warn, on: m.maintLeft === 0 && !m.busyLot && !m.holdLot },
        { color: C.ok, on: m.busyLot !== null },
      ];
  // ポール
  ctx.strokeStyle = '#b3bdc4';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + 3, y + 22);
  ctx.lineTo(x + 3, y + 24);
  ctx.stroke();
  states.forEach((s, idx) => {
    ctx.beginPath();
    ctx.arc(x + 3, y + 4 + idx * 7, 3, 0, Math.PI * 2);
    if (s.on) {
      ctx.fillStyle = s.color;
      ctx.fill();
      ctx.globalAlpha = 0.25;
      ctx.beginPath();
      ctx.arc(x + 3, y + 4 + idx * 7, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    } else {
      ctx.fillStyle = '#e2e7ea';
      ctx.fill();
      ctx.strokeStyle = '#cbd3d8';
      ctx.lineWidth = 0.75;
      ctx.stroke();
    }
  });
}

export function drawFoup(ctx: CanvasRenderingContext2D, cx: number, cy: number) {
  // FOUP: 半透明パープルのポッド
  rr(ctx, cx - 9, cy - 12, 18, 13, 2.5);
  ctx.fillStyle = C.foup;
  ctx.fill();
  ctx.strokeStyle = C.foupEdge;
  ctx.lineWidth = 1;
  ctx.stroke();
  // 蓋
  ctx.fillStyle = C.foupLid;
  ctx.fillRect(cx - 7, cy - 10, 14, 3);
  // 天面ハンドル(OHT把持部)
  ctx.fillStyle = C.foupEdge;
  ctx.fillRect(cx - 4, cy - 14, 8, 2.5);
}

// ---- レール ----

function drawRails(ctx: CanvasRenderingContext2D, game: Game, vs: ViewState) {
  const edges = game.rail.allEdges();
  if (edges.length === 0 && vs.railPath.length === 0) return;

  const center = (k: TileKey) => {
    const { c, r } = parseKey(k);
    return { x: (c + 0.5) * TILE, y: (r + 0.5) * TILE };
  };

  // 床に落ちるレールの影
  ctx.strokeStyle = C.railShadow;
  ctx.lineWidth = 8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [a, b] of edges) {
    const pa = center(a);
    const pb = center(b);
    ctx.moveTo(pa.x + 5, pa.y + 9);
    ctx.lineTo(pb.x + 5, pb.y + 9);
  }
  ctx.stroke();

  // 軌道ビーム
  ctx.strokeStyle = C.railCasing;
  ctx.lineWidth = 9;
  ctx.beginPath();
  for (const [a, b] of edges) {
    const pa = center(a);
    const pb = center(b);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();
  ctx.strokeStyle = C.railInner;
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (const [a, b] of edges) {
    const pa = center(a);
    const pb = center(b);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();

  // 進行方向シェブロン
  ctx.strokeStyle = C.chevron;
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  for (const [a, b] of edges) {
    const pa = center(a);
    const pb = center(b);
    drawChevron(ctx, (pa.x + pb.x) / 2, (pa.y + pb.y) / 2, pb.x - pa.x, pb.y - pa.y);
  }

  // 吊り金具
  ctx.fillStyle = '#8b969e';
  for (const k of game.rail.allNodes()) {
    const p = center(k);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawChevron(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, dx: number, dy: number,
) {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const s = 4;
  ctx.beginPath();
  ctx.moveTo(x - ux * s - uy * s, y - uy * s + ux * s);
  ctx.lineTo(x + ux * s * 0.6, y + uy * s * 0.6);
  ctx.lineTo(x - ux * s + uy * s, y - uy * s - ux * s);
  ctx.stroke();
}

// ---- ビークル ----

function drawVehicle(ctx: CanvasRenderingContext2D, v: Vehicle, time: number) {
  const { x, y } = vehiclePos(v);

  // 床上の影
  ctx.fillStyle = 'rgba(70,90,100,0.13)';
  ctx.beginPath();
  ctx.ellipse(x + 3, y + 10, 15, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // 吊り下げ中のFOUP(ビークル本体より先に描いて奥に見せる)
  const hoisting = v.hoistT > 0.01;
  if (v.carrying || (hoisting && v.state.startsWith('pick') && v.job)) {
    const drop = v.hoistT * 24;
    const fy = y + 14 + drop;
    if (hoisting) {
      ctx.strokeStyle = '#9aa5ad';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x - 5, y + 6);
      ctx.lineTo(x - 5, fy - 13);
      ctx.moveTo(x + 5, y + 6);
      ctx.lineTo(x + 5, fy - 13);
      ctx.stroke();
    }
    if (v.carrying) drawFoup(ctx, x, fy);
  }

  // 本体シャトル
  rr(ctx, x - 15, y - 9, 30, 18, 4);
  ctx.fillStyle = C.vehicleBody;
  ctx.fill();
  ctx.strokeStyle = C.vehicleEdge;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // 進行方向ノーズ
  if (v.target) {
    const a = parseKey(v.tile);
    const b = parseKey(v.target);
    const nx = x + (b.c - a.c) * 11;
    const ny = y + (b.r - a.r) * 6;
    ctx.fillStyle = '#c3ccd2';
    ctx.beginPath();
    ctx.arc(nx, ny, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // 状態LED
  ctx.beginPath();
  ctx.arc(x - 9, y - 4, 2, 0, Math.PI * 2);
  ctx.fillStyle = v.stuck
    ? (Math.sin(time * 8) > 0 ? C.bad : '#e2e7ea')
    : v.job ? C.accent : '#c3ccd2';
  ctx.fill();
}

// ---- ツールのオーバーレイ ----

function drawOverlays(ctx: CanvasRenderingContext2D, game: Game, vs: ViewState) {
  const { tool, cursor, selected } = vs;

  // 選択枠
  if (selected) {
    const def = MACHINE_DEFS[selected.kind];
    const lift = def.h === 1 ? LIFT1 : LIFT2;
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      selected.col * TILE + 1,
      selected.row * TILE + 1 - lift,
      def.w * TILE - 2,
      def.h * TILE - 2 + lift,
    );
    ctx.setLineDash([]);
  }

  // 設置ゴースト
  if (tool.mode === 'place' && tool.kind && cursor.inside) {
    const def = MACHINE_DEFS[tool.kind];
    const ok = game.canPlace(tool.kind, cursor.c, cursor.r);
    const x = cursor.c * TILE;
    const y = cursor.r * TILE;
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = ok ? 'rgba(93, 160, 112, 0.20)' : 'rgba(204, 79, 68, 0.20)';
    ctx.fillRect(x, y, def.w * TILE, def.h * TILE);
    ctx.strokeStyle = ok ? '#5da070' : C.bad;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(x + 1, y + 1, def.w * TILE - 2, def.h * TILE - 2);
    ctx.setLineDash([]);
    // 簡易シルエット
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.fillRect(x + 4, y + 4, def.w * TILE - 8, def.h * TILE - 8);
    ctx.fillStyle = def.accent;
    ctx.fillRect(x + 5, y + def.h * TILE - 10, def.w * TILE - 10, 4);
    ctx.fillStyle = C.ink;
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(def.short, x + (def.w * TILE) / 2, y + (def.h * TILE) / 2 - 4);
    ctx.globalAlpha = 1;
  }

  // レール敷設プレビュー
  if (vs.railPath.length > 0) {
    ctx.strokeStyle = 'rgba(119, 97, 167, 0.65)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < vs.railPath.length; i++) {
      const { c, r } = parseKey(vs.railPath[i]);
      const x = (c + 0.5) * TILE;
      const y = (r + 0.5) * TILE;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(119, 97, 167, 0.9)';
    ctx.lineWidth = 1.6;
    for (let i = 1; i < vs.railPath.length; i++) {
      const a = parseKey(vs.railPath[i - 1]);
      const b = parseKey(vs.railPath[i]);
      drawChevron(
        ctx,
        ((a.c + b.c) / 2 + 0.5) * TILE,
        ((a.r + b.r) / 2 + 0.5) * TILE,
        (b.c - a.c) * TILE,
        (b.r - a.r) * TILE,
      );
    }
  } else if (tool.mode === 'rail' && cursor.inside) {
    // 敷設開始位置マーカー
    ctx.strokeStyle = 'rgba(119, 97, 167, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(cursor.c * TILE + 3, cursor.r * TILE + 3, TILE - 6, TILE - 6);
    ctx.setLineDash([]);
  }

  // レール撤去カーソル
  if (tool.mode === 'railErase' && cursor.inside) {
    const k = tkey(cursor.c, cursor.r);
    const has = game.rail.hasNode(k);
    ctx.strokeStyle = has ? C.bad : 'rgba(204,79,68,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc((cursor.c + 0.5) * TILE, (cursor.r + 0.5) * TILE, 12, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo((cursor.c + 0.5) * TILE - 6, (cursor.r + 0.5) * TILE);
    ctx.lineTo((cursor.c + 0.5) * TILE + 6, (cursor.r + 0.5) * TILE);
    ctx.stroke();
  }

  // 装置撤去ハイライト
  if (tool.mode === 'demolish' && cursor.inside) {
    const m = game.machineAtTile(cursor.c, cursor.r);
    if (m && MACHINE_DEFS[m.kind].placeable) {
      const def = MACHINE_DEFS[m.kind];
      const lift = def.h === 1 ? LIFT1 : LIFT2;
      ctx.strokeStyle = C.bad;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(
        m.col * TILE + 1, m.row * TILE + 1 - lift,
        def.w * TILE - 2, def.h * TILE - 2 + lift,
      );
      ctx.setLineDash([]);
    }
  }
}

function rr(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
