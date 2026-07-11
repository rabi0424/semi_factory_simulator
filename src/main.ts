import { TILE, MAP_COLS, MAP_ROWS, AUTOSAVE_INTERVAL } from './config';
import { Game } from './sim';
import { saveToLocal, loadFromLocal } from './save';
import { createScene } from './three/scene';
import { View3D } from './three/view3d';
import type { ViewState } from './view';
import { createUI } from './ui';
import { sound } from './sound';
import { tkey, parseKey } from './rail';
import type { TileKey } from './rail';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const overlay = document.getElementById('hud') as HTMLElement;
const toast = document.getElementById('toast') as HTMLElement;

// ---- 3Dシーン ----
const sceneCtx = createScene(canvas);
window.addEventListener('resize', sceneCtx.resize);

const game = new Game();
const vs: ViewState = {
  cursor: { c: -1, r: -1, inside: false },
  tool: { mode: 'select', kind: null },
  toolRot: 0,
  railPath: [],
  selected: null,
  highlightKind: null,
  showHeat: false,
  time: 0,
};

let toastTimer = 0;
game.onMessage = (msg) => {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2200);
  // メッセージ種別ごとの通知音
  if (msg.includes('資金不足') || msg.includes('できません') || msg.includes('必要です')) sound.deny();
  else if (msg.includes('🎉') || msg.includes('🔬') || msg.includes('✅')) sound.unlock();
};

// コンテキストカードのアンカー: 装置の右肩上空を画面座標へ投影
const ui = createUI({
  root: overlay,
  game,
  vs,
  worldToScreen: (x, z) => sceneCtx.worldToScreen(x, 1.8, z),
  getMode: () => sceneCtx.mode,
  toggleMode: () => setViewMode(sceneCtx.mode === '3d' ? '2d' : '3d'),
});

function setViewMode(mode: '2d' | '3d') {
  sceneCtx.setMode(mode);
  game.onMessage(mode === '2d' ? '2Dモード(真上固定)に切替' : '3Dモードに切替');
}

const view3d = new View3D(sceneCtx.scene, sceneCtx.overlay);

// ---- 入力(Pointer Events: 左=ツール, 右クリック=装置回転/右ドラッグ=視点回転(3D),
// 中=パン, ホイール=ズーム) ----
let railDragging = false;
let railErasing = false;
let rightDown: { x: number; y: number } | null = null;
const RIGHT_CLICK_DRAG_TOLERANCE = 6; // px。これ未満の移動は「クリック」とみなす

function updateCursor(clientX: number, clientY: number) {
  const t = sceneCtx.pickTile(clientX, clientY);
  vs.cursor.c = t.c;
  vs.cursor.r = t.r;
  vs.cursor.inside = t.inside;
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
  // 資金不足なら1区間も敷かれない(トースト+エラー音はonMessage側)
  if (vs.railPath.length > 1 && game.buyRailPath(vs.railPath)) sound.rail();
  vs.railPath = [];
}

window.addEventListener('pointerdown', () => sound.resume(), { capture: true });

canvas.addEventListener('pointerdown', (e) => {
  updateCursor(e.clientX, e.clientY);
  if (e.button === 2) {
    // ドラッグか単クリックかは pointerup 側で判定する
    rightDown = { x: e.clientX, y: e.clientY };
    return;
  }
  if (e.button !== 0) return; // 中ボタンはカメラのパン(OrbitControls)
  if (!vs.cursor.inside) {
    if (vs.tool.mode === 'select') vs.selected = null;
    return;
  }
  const { c, r } = vs.cursor;

  switch (vs.tool.mode) {
    case 'select': {
      vs.selected = game.machineAtTile(c, r) ?? null;
      break;
    }
    case 'place': {
      if (vs.tool.kind && game.addMachine(vs.tool.kind, c, r, vs.toolRot)) {
        sound.place();
      }
      break;
    }
    case 'demolish': {
      const m = game.machineAtTile(c, r);
      if (m && game.removeMachine(m)) sound.place();
      break;
    }
    case 'rail': {
      railDragging = true;
      vs.railPath = [tkey(c, r)];
      canvas.setPointerCapture(e.pointerId);
      break;
    }
    case 'railErase': {
      railErasing = true;
      game.removeRailTile(c, r);
      canvas.setPointerCapture(e.pointerId);
      break;
    }
  }
});

window.addEventListener('pointermove', (e) => {
  updateCursor(e.clientX, e.clientY);
  if (railDragging && vs.cursor.inside) {
    extendRailPath(vs.cursor.c, vs.cursor.r);
  } else if (railErasing && vs.cursor.inside) {
    game.removeRailTile(vs.cursor.c, vs.cursor.r);
  }
});

window.addEventListener('pointerup', (e) => {
  if (e.button === 2 && rightDown) {
    const dist = Math.hypot(e.clientX - rightDown.x, e.clientY - rightDown.y);
    rightDown = null;
    // ドラッグでなければ(視点回転ではなく)単なる右クリック
    // → 設置ツール中は装置の向きを時計回りに回転
    if (dist < RIGHT_CLICK_DRAG_TOLERANCE && vs.tool.mode === 'place') {
      vs.toolRot = (vs.toolRot + 1) % 4;
    }
  }
  if (railDragging) commitRailPath();
  railDragging = false;
  railErasing = false;
});

canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
  if (e.key === 'Shift') {
    if (e.repeat) return; // 押しっぱなしでの誤連続切替を防ぐ
    setViewMode(sceneCtx.mode === '3d' ? '2d' : '3d');
    return;
  }
  if (e.key === 'Escape') {
    ui.setTool({ mode: 'select', kind: null });
    vs.selected = null;
    vs.highlightKind = null;
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
  if (e.key === 'g' || e.key === 'G') {
    ui.toggleTech();
    return;
  }
  // 矢印キー: 注視点を水平パン
  const pan = 1.6;
  const move = (dx: number, dz: number) => {
    sceneCtx.controls.target.x += dx;
    sceneCtx.controls.target.z += dz;
    sceneCtx.camera.position.x += dx;
    sceneCtx.camera.position.z += dz;
  };
  if (e.key === 'ArrowLeft') move(-pan, 0);
  else if (e.key === 'ArrowRight') move(pan, 0);
  else if (e.key === 'ArrowUp') move(0, -pan);
  else if (e.key === 'ArrowDown') move(0, pan);
  else ui.selectToolByKey(e.key);
});

// ---- セーブ/ロード ----
if (loadFromLocal(game)) {
  setTimeout(() => game.onMessage('前回のセーブデータを読み込みました'), 400);
  // 旧バージョンからの移行注意(ロード通知のトーストが消えた頃に表示)
  if (game.migrationNotice) {
    const notice = game.migrationNotice;
    setTimeout(() => game.onMessage(notice), 3200);
  }
}
window.addEventListener('beforeunload', () => saveToLocal(game));

// ---- ループ ----
let last = performance.now();
let uiTimer = 0;
let saveTimer = 0;
let lastCompleted = game.completedCount;

function frame(now: number) {
  // 低fps環境でもシミュレーション実速度を保てるよう上限は広めに取る。
  // タイマー異常(rAFタイムスタンプの逆行)で負のdtが入るとシム時刻が
  // 巻き戻ってUI更新まで止まるため、下限0でクランプする
  const dt = Math.max(0, Math.min(0.25, (now - last) / 1000));
  last = now;
  vs.time += dt;

  game.update(dt);
  view3d.sync(game, vs, sceneCtx.camera);
  sceneCtx.controls.update();
  sceneCtx.render();

  uiTimer += dt;
  if (uiTimer >= 0.15) {
    uiTimer = 0;
    ui.refresh();
    // ロット完成のチャイム(メッセージが無いイベントなのでカウンタ監視)
    if (game.completedCount > lastCompleted) sound.chime();
    lastCompleted = game.completedCount;
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
      vs: ViewState;
      TILE: number;
      // 旧2D互換: px座標(タイル×TILE)を受けて画面座標を返す
      worldToScreen: (px: number, py: number) => { x: number; y: number };
      addRail: (tiles: [number, number][]) => void;
      scene?: unknown; // デバッグ用
      camera?: unknown; // デバッグ用(常に現在アクティブなカメラを指す)
      controls?: unknown; // デバッグ用(カメラ移動テストに使う)
      mode?: '2d' | '3d';
      setMode?: (mode: '2d' | '3d') => void;
    };
  }
}
window.__sim = {
  game, vs, TILE,
  scene: sceneCtx.scene,
  controls: sceneCtx.controls,
  get camera() { return sceneCtx.camera; },
  get mode() { return sceneCtx.mode; },
  setMode: setViewMode,
  worldToScreen: (px, py) => sceneCtx.worldToScreen(px / TILE, 0, py / TILE),
  addRail: (tiles) => {
    for (let i = 1; i < tiles.length; i++) {
      game.rail.addEdge(
        tkey(tiles[i - 1][0], tiles[i - 1][1]) as TileKey,
        tkey(tiles[i][0], tiles[i][1]) as TileKey,
      );
    }
  },
};
