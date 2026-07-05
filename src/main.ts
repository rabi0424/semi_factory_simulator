import { COLS, ROWS, TILE } from './config';
import { Game } from './sim';
import { render, drawRoutes } from './render';
import type { RenderState } from './render';
import { createUI } from './ui';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const panel = document.getElementById('panel') as HTMLElement;
const toast = document.getElementById('toast') as HTMLElement;

// 高DPI対応
const dpr = window.devicePixelRatio || 1;
canvas.width = COLS * TILE * dpr;
canvas.height = ROWS * TILE * dpr;
canvas.style.width = `${COLS * TILE}px`;
canvas.style.height = `${ROWS * TILE}px`;
const ctx = canvas.getContext('2d')!;
ctx.scale(dpr, dpr);

const game = new Game();
const rs: RenderState = {
  placeKind: null,
  deleteMode: false,
  selected: null,
  cursor: { col: -1, row: -1, inside: false },
};

let toastTimer = 0;
game.onMessage = (msg) => {
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.style.opacity = '0'), 2200);
};

const ui = createUI(panel, game, rs);
const notifyModeChange = () => panel.dispatchEvent(new Event('modechange'));

// ---- 入力 ----
canvas.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  rs.cursor.col = Math.floor(x / TILE);
  rs.cursor.row = Math.floor(y / TILE);
  rs.cursor.inside =
    rs.cursor.col >= 0 && rs.cursor.col < COLS &&
    rs.cursor.row >= 0 && rs.cursor.row < ROWS;
});
canvas.addEventListener('mouseleave', () => (rs.cursor.inside = false));

canvas.addEventListener('click', () => {
  if (!rs.cursor.inside) return;
  const { col, row } = rs.cursor;
  const m = game.machineAt(col, row);

  if (rs.placeKind) {
    game.addMachine(rs.placeKind, col, row);
    return;
  }
  if (rs.deleteMode) {
    if (m) game.removeMachine(m);
    return;
  }
  rs.selected = m ?? null;
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  rs.placeKind = null;
  rs.deleteMode = false;
  notifyModeChange();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    rs.placeKind = null;
    rs.deleteMode = false;
    rs.selected = null;
    notifyModeChange();
  }
});

// ---- ゲームループ ----
let last = performance.now();
let uiTimer = 0;

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  game.update(dt);
  render(ctx, game, rs);
  drawRoutes(ctx, game);

  uiTimer += dt;
  if (uiTimer >= 0.2) {
    uiTimer = 0;
    ui.refresh();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
