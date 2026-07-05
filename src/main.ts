import { TILE, MAP_COLS, MAP_ROWS, AUTOSAVE_INTERVAL } from './config';
import { Game } from './sim';
import { saveToLocal, loadFromLocal } from './save';
import { render } from './render';
import type { ViewState, Camera } from './render';
import { createUI } from './ui';
import { tkey, parseKey } from './rail';
import type { TileKey } from './rail';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const overlay = document.getElementById('hud') as HTMLElement;
const toast = document.getElementById('toast') as HTMLElement;

const dpr = window.devicePixelRatio || 1;
let cssW = window.innerWidth;
let cssH = window.innerHeight;

function resize() {
  cssW = window.innerWidth;
  cssH = window.innerHeight;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
}
resize();
window.addEventListener('resize', resize);

// ---- カメラ(初期状態: マップ全体をフィット) ----
const cam: Camera = { x: 0, y: 0, scale: 1 };
{
  const mapW = MAP_COLS * TILE;
  const mapH = MAP_ROWS * TILE;
  cam.scale = Math.min((cssW - 40) / mapW, (cssH - 140) / mapH);
  cam.scale = Math.max(0.45, Math.min(2.4, cam.scale));
  cam.x = (mapW - cssW / cam.scale) / 2;
  cam.y = (mapH - (cssH - 30) / cam.scale) / 2;
}

const game = new Game();
const vs: ViewState = {
  cam,
  cursor: { c: -1, r: -1, inside: false },
  tool: { mode: 'select', kind: null },
  toolRot: 0,
  railPath: [],
  selected: null,
  showHeat: false,
  time: 0,
};

let toastTimer = 0;
game.onMessage = (msg) => {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2200);
};

const worldToScreen = (wx: number, wy: number) => ({
  x: (wx - cam.x) * cam.scale,
  y: (wy - cam.y) * cam.scale,
});
const screenToWorld = (sx: number, sy: number) => ({
  x: sx / cam.scale + cam.x,
  y: sy / cam.scale + cam.y,
});

const ui = createUI({ root: overlay, game, vs, worldToScreen });

// ---- 入力 ----
let panning = false;
let railDragging = false;
let railErasing = false;
let spaceHeld = false;
let lastMouse = { x: 0, y: 0 };

function updateCursor(sx: number, sy: number) {
  const w = screenToWorld(sx, sy);
  const c = Math.floor(w.x / TILE);
  const r = Math.floor(w.y / TILE);
  vs.cursor.c = c;
  vs.cursor.r = r;
  vs.cursor.inside = c >= 0 && r >= 0 && c < MAP_COLS && r < MAP_ROWS;
}

// レール敷設ドラッグの経路延長(マンハッタン経路で補間、直前タイルへ戻ると取り消し)
function extendRailPath(c: number, r: number) {
  c = Math.max(0, Math.min(MAP_COLS - 1, c));
  r = Math.max(0, Math.min(MAP_ROWS - 1, r));
  const path = vs.railPath;
  if (path.length >= 2) {
    const prev = parseKey(path[path.length - 2]);
    if (prev.c === c && prev.r === r) {
      path.pop();
      return;
    }
  }
  let last = parseKey(path[path.length - 1]);
  let guard = 64;
  while ((last.c !== c || last.r !== r) && guard-- > 0) {
    if (last.c !== c) last = { c: last.c + Math.sign(c - last.c), r: last.r };
    else last = { c: last.c, r: last.r + Math.sign(r - last.r) };
    const k = tkey(last.c, last.r);
    if (path[path.length - 1] !== k) path.push(k);
  }
}

function commitRailPath() {
  const path = vs.railPath;
  for (let i = 1; i < path.length; i++) game.rail.addEdge(path[i - 1], path[i]);
  vs.railPath = [];
}

canvas.addEventListener('mousedown', (e) => {
  lastMouse = { x: e.clientX, y: e.clientY };
  updateCursor(e.clientX, e.clientY);
  if (e.button === 1 || e.button === 2 || spaceHeld) {
    panning = true;
    return;
  }
  if (e.button !== 0 || !vs.cursor.inside) return;
  const { c, r } = vs.cursor;

  switch (vs.tool.mode) {
    case 'select': {
      vs.selected = game.machineAtTile(c, r) ?? null;
      break;
    }
    case 'place': {
      if (vs.tool.kind) game.addMachine(vs.tool.kind, c, r, vs.toolRot);
      break;
    }
    case 'demolish': {
      const m = game.machineAtTile(c, r);
      if (m) game.removeMachine(m);
      break;
    }
    case 'rail': {
      railDragging = true;
      vs.railPath = [tkey(c, r)];
      break;
    }
    case 'railErase': {
      railErasing = true;
      game.removeRailTile(c, r);
      break;
    }
  }
});

window.addEventListener('mousemove', (e) => {
  updateCursor(e.clientX, e.clientY);
  if (panning) {
    cam.x -= (e.clientX - lastMouse.x) / cam.scale;
    cam.y -= (e.clientY - lastMouse.y) / cam.scale;
  } else if (railDragging && vs.cursor.inside) {
    extendRailPath(vs.cursor.c, vs.cursor.r);
  } else if (railErasing && vs.cursor.inside) {
    game.removeRailTile(vs.cursor.c, vs.cursor.r);
  }
  lastMouse = { x: e.clientX, y: e.clientY };
});

window.addEventListener('mouseup', () => {
  if (railDragging) commitRailPath();
  panning = false;
  railDragging = false;
  railErasing = false;
});

canvas.addEventListener('mouseleave', () => (vs.cursor.inside = false));
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    const before = screenToWorld(e.clientX, e.clientY);
    const factor = Math.pow(1.0015, -e.deltaY);
    cam.scale = Math.max(0.45, Math.min(2.4, cam.scale * factor));
    const after = screenToWorld(e.clientX, e.clientY);
    cam.x += before.x - after.x;
    cam.y += before.y - after.y;
  },
  { passive: false },
);

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (e.key === ' ') {
    spaceHeld = true;
    e.preventDefault();
    return;
  }
  if (e.key === 'Escape') {
    ui.setTool({ mode: 'select', kind: null });
    vs.selected = null;
    return;
  }
  if (e.key === 'f' || e.key === 'F') {
    ui.toggleFlow();
    return;
  }
  if (e.key === 'r' || e.key === 'R') {
    vs.toolRot = (vs.toolRot + 1) % 4;
    return;
  }
  if (e.key === 'h' || e.key === 'H') {
    ui.toggleHeat();
    return;
  }
  const panStep = 60 / cam.scale;
  if (e.key === 'ArrowLeft') cam.x -= panStep;
  else if (e.key === 'ArrowRight') cam.x += panStep;
  else if (e.key === 'ArrowUp') cam.y -= panStep;
  else if (e.key === 'ArrowDown') cam.y += panStep;
  else ui.selectToolByKey(e.key);
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ') spaceHeld = false;
});

// ---- セーブ/ロード ----
if (loadFromLocal(game)) {
  setTimeout(() => game.onMessage('前回のセーブデータを読み込みました'), 400);
}
window.addEventListener('beforeunload', () => saveToLocal(game));

// ---- ループ ----
let last = performance.now();
let uiTimer = 0;
let saveTimer = 0;

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  vs.time += dt;

  game.update(dt);
  render(ctx, game, vs, cssW, cssH, dpr);

  uiTimer += dt;
  if (uiTimer >= 0.15) {
    uiTimer = 0;
    ui.refresh();
  }
  saveTimer += dt;
  if (saveTimer >= AUTOSAVE_INTERVAL) {
    saveTimer = 0;
    saveToLocal(game);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// E2Eテスト・デバッグ用フック
declare global {
  interface Window {
    __sim?: {
      game: Game;
      cam: Camera;
      vs: ViewState;
      TILE: number;
      worldToScreen: typeof worldToScreen;
      addRail: (tiles: [number, number][]) => void;
    };
  }
}
window.__sim = {
  game, cam, vs, TILE, worldToScreen,
  addRail: (tiles) => {
    for (let i = 1; i < tiles.length; i++) {
      game.rail.addEdge(
        tkey(tiles[i - 1][0], tiles[i - 1][1]) as TileKey,
        tkey(tiles[i][0], tiles[i][1]) as TileKey,
      );
    }
  },
};
