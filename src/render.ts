import { COLS, ROWS, TILE, MACHINE_DEFS, RECIPE, MAINT_TIME } from './config';
import type { MachineKind } from './config';
import { Game, centerOf } from './sim';
import type { Machine, Lot } from './sim';

export interface Cursor {
  col: number;
  row: number;
  inside: boolean;
}

export interface RenderState {
  placeKind: MachineKind | null; // パレットで選択中の装置
  deleteMode: boolean;
  selected: Machine | null;
  cursor: Cursor;
}

export function render(
  ctx: CanvasRenderingContext2D,
  game: Game,
  rs: RenderState,
) {
  const W = COLS * TILE;
  const H = ROWS * TILE;
  ctx.clearRect(0, 0, W, H);

  // グリッド
  ctx.strokeStyle = '#222835';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let c = 1; c < COLS; c++) {
    ctx.moveTo(c * TILE + 0.5, 0);
    ctx.lineTo(c * TILE + 0.5, H);
  }
  for (let r = 1; r < ROWS; r++) {
    ctx.moveTo(0, r * TILE + 0.5);
    ctx.lineTo(W, r * TILE + 0.5);
  }
  ctx.stroke();

  for (const m of game.machines) drawMachine(ctx, m, rs);
  for (const lot of game.lots) drawLot(ctx, lot);

  drawGhost(ctx, game, rs);
}

function drawMachine(
  ctx: CanvasRenderingContext2D,
  m: Machine,
  rs: RenderState,
) {
  const def = MACHINE_DEFS[m.kind];
  const x = m.col * TILE;
  const y = m.row * TILE;
  const pad = 4;

  ctx.save();

  // 本体
  roundRect(ctx, x + pad, y + pad, TILE - pad * 2, TILE - pad * 2, 8);
  ctx.fillStyle = m.maintLeft > 0 ? '#3a3020' : '#242c3a';
  ctx.fill();
  ctx.lineWidth = rs.selected === m ? 3 : 2;
  ctx.strokeStyle = rs.selected === m ? '#ffffff' : def.color;
  ctx.stroke();

  // 名称
  ctx.fillStyle = def.color;
  ctx.font = 'bold 13px "Hiragino Sans", "Noto Sans JP", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(def.short, x + TILE / 2, y + TILE / 2 - 3);

  // 清浄度バー(可動装置のみ)
  if (def.placeable) {
    const bw = TILE - pad * 2 - 8;
    const bx = x + pad + 4;
    const by = y + TILE - pad - 8;
    ctx.fillStyle = '#151a23';
    ctx.fillRect(bx, by, bw, 4);
    const c = m.cleanliness;
    ctx.fillStyle = c > 0.6 ? '#66bb6a' : c > 0.35 ? '#ffca28' : '#ef5350';
    ctx.fillRect(bx, by, bw * c, 4);
  }

  // 処理進捗バー
  if (m.busyLot) {
    const total = MACHINE_DEFS[m.kind].procTime;
    const p = 1 - m.procLeft / total;
    const bw = TILE - pad * 2 - 8;
    ctx.fillStyle = '#151a23';
    ctx.fillRect(x + pad + 4, y + pad + 4, bw, 4);
    ctx.fillStyle = '#4fc3f7';
    ctx.fillRect(x + pad + 4, y + pad + 4, bw * p, 4);
  }

  // メンテナンス表示
  if (m.maintLeft > 0) {
    ctx.fillStyle = '#ffca28';
    ctx.font = '11px sans-serif';
    ctx.fillText(
      `整備 ${Math.ceil(m.maintLeft)}s`,
      x + TILE / 2,
      y + pad + 10,
    );
    // 残り時間リング
    const p = 1 - m.maintLeft / MAINT_TIME;
    ctx.beginPath();
    ctx.arc(x + TILE / 2, y + TILE / 2 + 12, 7, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
    ctx.strokeStyle = '#ffca28';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // 待機数
  if (m.queue.length > 0) {
    ctx.fillStyle = '#8b96a8';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`待${m.queue.length}`, x + TILE - pad - 3, y + pad + 10);
  }

  ctx.restore();
}

function drawLot(ctx: CanvasRenderingContext2D, lot: Lot) {
  let x = lot.x;
  let y = lot.y;
  if (lot.state === 'waiting' || lot.state === 'queued') {
    x += lot.jitterX;
    y += lot.jitterY;
  }
  if (lot.state === 'processing') return; // 装置内は進捗バーで表現

  const size = 13;
  const progress = Math.min(1, lot.step / RECIPE.length);
  // 工程が進むほど 灰→青→緑
  const hue = 210 - progress * 90;
  const sat = 15 + progress * 65;

  ctx.save();
  roundRect(ctx, x - size / 2, y - size / 2, size, size, 3);
  ctx.fillStyle = `hsl(${hue} ${sat}% 55%)`;
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // 歩留まりが下がったロットは赤点で警告
  if (lot.yield_ < 0.6) {
    ctx.beginPath();
    ctx.arc(x + size / 2 - 2, y - size / 2 + 2, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ef5350';
    ctx.fill();
  }
  ctx.restore();
}

function drawGhost(
  ctx: CanvasRenderingContext2D,
  game: Game,
  rs: RenderState,
) {
  const { col, row, inside } = rs.cursor;
  if (!inside) return;

  const occupied = game.machineAt(col, row);
  const x = col * TILE;
  const y = row * TILE;

  if (rs.placeKind) {
    const def = MACHINE_DEFS[rs.placeKind];
    ctx.save();
    ctx.globalAlpha = 0.55;
    roundRect(ctx, x + 4, y + 4, TILE - 8, TILE - 8, 8);
    ctx.fillStyle = occupied ? '#5a2626' : '#242c3a';
    ctx.fill();
    ctx.strokeStyle = occupied ? '#ef5350' : def.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    if (!occupied) {
      ctx.fillStyle = def.color;
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(def.short, x + TILE / 2, y + TILE / 2);
    }
    ctx.restore();
  } else if (rs.deleteMode && occupied && MACHINE_DEFS[occupied.kind].placeable) {
    ctx.save();
    roundRect(ctx, x + 4, y + 4, TILE - 8, TILE - 8, 8);
    ctx.strokeStyle = '#ef5350';
    ctx.lineWidth = 3;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.restore();
  }
}

// 搬送中ロットの行き先を示す細い線
export function drawRoutes(ctx: CanvasRenderingContext2D, game: Game) {
  ctx.save();
  ctx.strokeStyle = 'rgba(139,150,168,0.25)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 6]);
  for (const lot of game.lots) {
    if (lot.state !== 'moving' || !lot.target) continue;
    const c = centerOf(lot.target);
    ctx.beginPath();
    ctx.moveTo(lot.x, lot.y);
    ctx.lineTo(c.x, c.y);
    ctx.stroke();
  }
  ctx.restore();
}

function roundRect(
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
