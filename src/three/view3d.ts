// ゲーム状態 → 3Dシーンの同期層。
// 装置(2.5階建ての白い筐体+積層灯+銘板)、天井レール、OHTビークル、
// FOUP、渋滞ヒート、ツールオーバーレイをフレームごとに反映する。

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import {
  TILE, CEIL_Y, MACHINE_DEFS, PRODUCTS, FURNACE_BATCH,
  rotSize, rotPorts, servesOf,
} from '../config';
import type { MachineKind } from '../config';
import { Game } from '../sim';
import type { Machine, Lot } from '../sim';
import { parseKey } from '../rail';
import { vehiclePos } from '../oht';
import type { Vehicle } from '../oht';
import type { ViewState } from '../view';

export const RAIL_Y = 2.35;       // 天井レール高さ
const FOUP_UNDER_VEH = 0.34;      // 走行中FOUPのビークル下面からの距離
const FOUP_DOCK_Y = 0.24;         // ドック上のFOUP基準高さ
const PLATE_FADE_NEAR = 9;        // この距離までは銘板を全表示
const PLATE_FADE_FAR = 22;        // この距離を超えると銘板を完全に消す
const ORTHO_FADE_BASE_DIST = 13;  // 2Dモードでズーム=1のときの相当距離

function clamp01(t: number): number {
  return Math.max(0, Math.min(1, t));
}

// 装置本体の高さ [ユニット]
const BODY_H: Record<MachineKind, number> = {
  load: 0.45, ship: 0.45,
  clean: 1.0, depo: 1.15,
  litho: 1.2, krf: 1.25, arf: 1.3, euv: 1.4, euvhna: 1.5,
  etch: 1.15,
  furnace: 1.05, implant: 1.1, ald: 1.1,
  metal: 1.05, cu: 1.1, cmp: 0.85,
  inspect: 0.7, stocker: 1.85,
};

// ---- 共有ジオメトリ / マテリアル ----

const GEO = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 20),
  sphere: new THREE.SphereGeometry(0.5, 14, 10),
  cone: new THREE.ConeGeometry(0.5, 1, 4),
  circle: new THREE.CircleGeometry(0.5, 24),
  torus: new THREE.TorusGeometry(0.42, 0.05, 8, 28),
};

// 塗装板金のムラ(ラフネスマップ)。均一なマテリアルのCG臭さを消す
const bodyRoughTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d')!;
  g.fillStyle = 'rgb(120,120,120)';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const v = 120 + (Math.random() - 0.5) * 52;
    g.fillStyle = `rgba(${v},${v},${v},0.5)`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2 + Math.random() * 6, 2);
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
})();

const MAT = {
  body: new THREE.MeshPhysicalMaterial({
    color: '#f2f3f4', roughness: 0.42, roughnessMap: bodyRoughTex, metalness: 0.06,
    clearcoat: 0.25, clearcoatRoughness: 0.5,
  }),
  plinth: new THREE.MeshStandardMaterial({ color: '#565d63', roughness: 0.55, metalness: 0.3 }),
  dock: new THREE.MeshStandardMaterial({ color: '#c2cad0', roughness: 0.5, metalness: 0.4 }),
  tube: new THREE.MeshStandardMaterial({ color: '#dfe4e8', roughness: 0.28, metalness: 0.9 }),
  railBeam: new THREE.MeshStandardMaterial({ color: '#9aa5ad', roughness: 0.35, metalness: 0.8 }),
  railTop: new THREE.MeshStandardMaterial({ color: '#eef1f3', roughness: 0.3, metalness: 0.4 }),
  hanger: new THREE.MeshStandardMaterial({ color: '#7d8892', roughness: 0.5, metalness: 0.7 }),
  chevron: new THREE.MeshStandardMaterial({ color: '#88949c', roughness: 0.55 }),
  vehicle: new THREE.MeshPhysicalMaterial({
    color: '#f4f6f7', roughness: 0.35, metalness: 0.1,
    clearcoat: 0.4, clearcoatRoughness: 0.35,
  }),
  cable: new THREE.MeshStandardMaterial({ color: '#8b969e', roughness: 0.7 }),
  foupBody: new THREE.MeshPhysicalMaterial({
    color: '#a48ec7', roughness: 0.15, metalness: 0,
    transparent: true, opacity: 0.62,
    clearcoat: 1, clearcoatRoughness: 0.12,
  }),
  foupLid: new THREE.MeshStandardMaterial({ color: '#d3c7e8', roughness: 0.4 }),
  panel: new THREE.MeshPhysicalMaterial({
    color: '#eef0f1', roughness: 0.4, roughnessMap: bodyRoughTex, metalness: 0.06,
    clearcoat: 0.3, clearcoatRoughness: 0.45,
  }),
  dark: new THREE.MeshStandardMaterial({ color: '#2f353a', roughness: 0.6, metalness: 0.2 }),
  wafer: new THREE.MeshStandardMaterial({ color: '#6f7880', roughness: 0.15, metalness: 0.9 }),
  pole: new THREE.MeshStandardMaterial({ color: '#aeb8bf', roughness: 0.6, metalness: 0.5 }),
  ghostOk: new THREE.MeshStandardMaterial({
    color: '#5da070', transparent: true, opacity: 0.4, depthWrite: false,
  }),
  ghostNg: new THREE.MeshStandardMaterial({
    color: '#cc4f44', transparent: true, opacity: 0.4, depthWrite: false,
  }),
  preview: new THREE.MeshStandardMaterial({
    color: '#7761a7', transparent: true, opacity: 0.55, depthWrite: false,
  }),
  erase: new THREE.MeshBasicMaterial({ color: '#cc4f44' }),
};

const LIGHT_COLORS = { red: '#cc4f44', amber: '#d99a2b', green: '#3f9c5a', off: '#dde3e6' };

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function accentMat(color: string): THREE.MeshStandardMaterial {
  let m = matCache.get(color);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.5 });
    matCache.set(color, m);
  }
  return m;
}

function mesh(
  geo: THREE.BufferGeometry, mat: THREE.Material,
  sx: number, sy: number, sz: number,
  x: number, y: number, z: number,
  shadow = true,
): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  return m;
}

// 面取りボックス。寸法ごとにジオメトリをキャッシュして共有する
const rboxCache = new Map<string, RoundedBoxGeometry>();
function rboxGeo(w: number, h: number, d: number, r: number): RoundedBoxGeometry {
  const key = `${w.toFixed(3)}|${h.toFixed(3)}|${d.toFixed(3)}|${r.toFixed(3)}`;
  let g = rboxCache.get(key);
  if (!g) {
    g = new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2));
    rboxCache.set(key, g);
  }
  return g;
}

function rbox(
  w: number, h: number, d: number, mat: THREE.Material,
  x: number, y: number, z: number, r = 0.03, shadow = true,
): THREE.Mesh {
  const m = new THREE.Mesh(rboxGeo(w, h, d, r), mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  m.receiveShadow = true;
  return m;
}

// FOUP内のウェハ25枚(1つのジオメトリにマージして共有)
const waferStackGeo = (() => {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 25; i++) {
    const c = new THREE.CylinderGeometry(0.12, 0.12, 0.004, 24);
    c.translate(0, 0.045 + i * 0.0089, 0);
    parts.push(c);
  }
  return mergeGeometries(parts)!;
})();

// 装置のステータススクリーン(SCADA風)。内容は種別ごとに決定的に生成
const screenTexCache = new Map<string, THREE.CanvasTexture>();
function screenTex(kind: MachineKind): THREE.CanvasTexture {
  const cached = screenTexCache.get(kind);
  if (cached) return cached;
  const cv = document.createElement('canvas');
  cv.width = 192;
  cv.height = 128;
  const g = cv.getContext('2d')!;
  const seed = kind.charCodeAt(0) * 7 + kind.length * 13;
  g.fillStyle = '#0c1316';
  g.fillRect(0, 0, 192, 128);
  g.fillStyle = '#123339';
  g.fillRect(0, 0, 192, 24);
  g.fillStyle = '#7de8c8';
  g.font = '700 13px monospace';
  g.fillText(`${MACHINE_DEFS[kind].short}  RUN`, 8, 17);
  g.fillStyle = '#9fb4ba';
  g.font = '9px monospace';
  g.fillText(`RCP A-${(seed % 90 + 10)}  TEMP 22.${seed % 10}C`, 8, 40);
  g.fillText('VAC OK  FLOW OK', 8, 54);
  g.fillStyle = '#1b4d43';
  g.fillRect(8, 64, 176, 10);
  g.fillStyle = '#43d69a';
  g.fillRect(8, 64, 60 + (seed * 3) % 110, 10);
  for (let i = 0; i < 16; i++) {
    g.fillStyle = `rgba(67,214,154,${0.3 + ((i * 37 + seed) % 60) / 100})`;
    const bh = 10 + ((i * 53 + seed) % 26);
    g.fillRect(8 + i * 11, 122 - bh, 8, bh);
  }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  screenTexCache.set(kind, t);
  return t;
}

// ポート面(rot)基準の配置ヘルパ。along = 面に沿った位置、out = 面の外向き
function faceXZ(rot: number, along: number, out: number): [number, number] {
  switch (rot % 4) {
    case 0: return [along, out];   // 南(+z)
    case 1: return [-out, along];  // 西(-x)
    case 2: return [-along, -out]; // 北(-z)
    default: return [out, -along]; // 東(+x)
  }
}
const FACE_ROT_Y = [0, -Math.PI / 2, Math.PI, Math.PI / 2];

// ---- FOUP ----

interface FoupView {
  group: THREE.Group;
  band: THREE.Mesh;
  pop: number; // 出現アニメーション 0..1(1=定常)
}

function buildFoup(): FoupView {
  const group = new THREE.Group();
  // 半透明シェル(中のウェハが透ける)
  const shell = rbox(0.32, 0.3, 0.32, MAT.foupBody, 0, 0.155, 0, 0.05);
  group.add(shell);
  // ウェハ25枚(共有ジオメトリ)
  const wafers = new THREE.Mesh(waferStackGeo, MAT.wafer);
  group.add(wafers);
  // 製品識別バンド(下部)
  const band = mesh(GEO.box, accentMat('#888'), 0.33, 0.045, 0.33, 0, 0.025, 0, false);
  group.add(band);
  // 天面の把持フランジ
  group.add(mesh(GEO.box, MAT.foupLid, 0.13, 0.035, 0.13, 0, 0.325, 0, false));
  return { group, band, pop: 1 };
}

function setFoup(view: FoupView, lot: Lot | null) {
  if (lot && !view.group.visible) view.pop = 0; // 出現の瞬間にポップ開始
  view.group.visible = lot !== null;
  if (lot) view.band.material = accentMat(PRODUCTS[lot.product].color);
}

// FOUP出現ポップ(小さく現れて弾んで定常サイズへ)
function animFoupPop(view: FoupView, dt: number) {
  if (view.pop >= 1) return;
  view.pop = Math.min(1, view.pop + dt * 4);
  const t = view.pop;
  const back = 1 + 2.2 * Math.pow(t - 1, 3) + 1.2 * Math.pow(t - 1, 2); // easeOutBack風
  view.group.scale.setScalar(0.75 + 0.25 * back);
}

// ---- 銘板(ネームプレート)スプライト ----

interface Plate {
  sprite: THREE.Sprite;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  sig: string;
}

function buildPlate(): Plate {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 84;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    // オーバーレイシーンで最後に描くため深度は読まない
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }),
  );
  sprite.scale.set(1.85, 0.6, 1);
  return { sprite, canvas, tex, sig: '' };
}

function drawPlate(
  plate: Plate, accent: string, label: string,
  status: string, statusColor: string,
  clean: number | null, progress: number,
) {
  const g = plate.canvas.getContext('2d')!;
  g.clearRect(0, 0, 256, 84);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.strokeStyle = '#c2ccd2';
  g.lineWidth = 2;
  roundRect(g, 1, 1, 254, 82, 8);
  g.fill();
  g.stroke();
  g.fillStyle = accent;
  g.fillRect(1, 1, 7, 82);
  g.fillStyle = '#37444c';
  g.font = '700 24px system-ui, sans-serif';
  g.textBaseline = 'top';
  g.fillText(label, 20, 9);
  g.font = '600 19px system-ui, sans-serif';
  g.fillStyle = statusColor;
  g.fillText(status, 20, 38);
  if (clean !== null) {
    g.fillStyle = '#e6ebee';
    g.fillRect(20, 66, 100, 9);
    g.fillStyle = clean > 0.6 ? '#3f9c5a' : clean > 0.35 ? '#d99a2b' : '#cc4f44';
    g.fillRect(20, 66, 100 * clean, 9);
  }
  if (progress > 0) {
    g.fillStyle = '#e6ebee';
    g.fillRect(136, 66, 100, 9);
    g.fillStyle = accent;
    g.fillRect(136, 66, 100 * progress, 9);
  }
  plate.tex.needsUpdate = true;
}

function roundRect(
  g: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function buildAlertSprite(): THREE.Sprite {
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 64;
  const g = cv.getContext('2d')!;
  g.beginPath();
  g.arc(32, 32, 28, 0, Math.PI * 2);
  g.fillStyle = '#d99a2b';
  g.fill();
  g.fillStyle = '#fff';
  g.font = '800 42px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('!', 32, 35);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: false, depthWrite: false,
  }));
  s.scale.set(0.45, 0.45, 1);
  return s;
}

// ---- 装置ビュー ----

interface MachineView {
  group: THREE.Group;
  lights: THREE.Mesh[];      // 積層灯 [赤, 黄, 緑]
  plate: Plate;
  alert: THREE.Sprite;
  portFoups: FoupView[];     // ポート順
  slotFoups: FoupView[];     // ストッカー棚 / 炉のチューブ
  topY: number;
  doors: { mesh: THREE.Mesh; closedY: number }[]; // ポート上部のスライド扉
  doorT: number;             // 扉の開閉補間 0(閉)..1(開)
  glowMat: THREE.MeshStandardMaterial | null; // 炉チューブの発熱グロー
  spinner: THREE.Mesh | null; // 稼働中に回る部位(CMPプラテン)
}

function buildMachine(m: Machine): MachineView {
  const def = MACHINE_DEFS[m.kind];
  const group = new THREE.Group();
  group.position.set(m.col + m.w / 2, 0, m.row + m.h / 2);
  const H = BODY_H[m.kind];
  let topY = 0.1 + H;

  const rot = m.rot % 4;
  const faceLen = (rot % 2 === 0 ? m.w : m.h) - 0.18;  // ポート面の横幅
  const outHalf = (rot % 2 === 0 ? m.h : m.w) / 2 - 0.09; // 中心からポート面まで
  // ポート面基準でボックスを置く(alongSize=面に沿った幅、outSize=奥行)
  const fbox = (
    mat: THREE.Material, alongSize: number, ySize: number, outSize: number,
    along: number, y: number, out: number, r = 0.015, shadow = true,
  ): THREE.Mesh => {
    const [x, z] = faceXZ(rot, along, out);
    const [sx, sz] = rot % 2 === 0 ? [alongSize, outSize] : [outSize, alongSize];
    const mm = rbox(sx, ySize, sz, mat, x, y, z, r, shadow);
    group.add(mm);
    return mm;
  };

  // ベースフレーム(キックプレート)
  group.add(rbox(m.w - 0.06, 0.12, m.h - 0.06, MAT.plinth, 0, 0.06, 0, 0.02));

  const slotFoups: FoupView[] = [];
  const doors: { mesh: THREE.Mesh; closedY: number }[] = [];
  let glowMat: THREE.MeshStandardMaterial | null = null;
  let spinner: THREE.Mesh | null = null;

  if (m.kind === 'stocker') {
    // 自動倉庫: 下段キャビネット+ラックにFOUPが並ぶ(2段×3列)
    group.add(rbox(m.w - 0.18, 0.82, m.h - 0.18, MAT.body, 0, 0.1 + 0.41, 0, 0.045));
    const rackTop = 1.78;
    for (const sx of [-(m.w / 2 - 0.24), m.w / 2 - 0.24]) {
      for (const sz of [-(m.h / 2 - 0.24), m.h / 2 - 0.24]) {
        group.add(rbox(0.06, rackTop - 0.92, 0.06, MAT.hanger,
          sx, 0.92 + (rackTop - 0.92) / 2, sz, 0.01));
      }
    }
    for (const sy of [0.96, 1.4]) {
      group.add(rbox(m.w - 0.3, 0.05, m.h - 0.55, MAT.panel, 0, sy, 0, 0.015));
    }
    group.add(rbox(m.w - 0.18, 0.07, m.h - 0.3, MAT.body, 0, rackTop + 0.04, 0, 0.02));
    for (let i = 0; i < 6; i++) {
      const fv = buildFoup();
      fv.group.position.set(((i % 3) - 1) * 0.55, i < 3 ? 0.99 : 1.43, 0);
      fv.group.visible = false;
      group.add(fv.group);
      slotFoups.push(fv);
    }
  } else {
    // 本体(面取り筐体)
    group.add(rbox(m.w - 0.18, H, m.h - 0.18, MAT.body, 0, 0.1 + H / 2, 0, 0.045));
  }

  // アクセント帯(ポート面)
  fbox(accentMat(def.accent), faceLen - 0.08, 0.1, 0.03, 0, 0.35, outHalf + 0.005, 0.008, false);

  // 前面パネル分割(目地の影で板金に見せる)+ ラッチ金具
  if (def.placeable && m.kind !== 'stocker' && H >= 0.8) {
    const usable = faceLen - 0.2;
    const n = Math.max(2, Math.round(usable / 0.95));
    const pw = usable / n - 0.035;
    const ph = H - 0.52;
    for (let i = 0; i < n; i++) {
      const along = -usable / 2 + (usable / n) * (i + 0.5);
      fbox(MAT.panel, pw, ph, 0.05, along, 0.46 + ph / 2, outHalf - 0.01, 0.015);
      fbox(MAT.tube, 0.05, 0.09, 0.03,
        along + pw / 2 - 0.07, 0.46 + ph - 0.14, outHalf + 0.02, 0.008, false);
    }
    // 排気ルーバー(面の左下)
    if (H >= 0.95) {
      const la = -usable / 2 + 0.34;
      fbox(MAT.dark, 0.5, 0.3, 0.03, la, 0.66, outHalf + 0.015, 0.01, false);
      for (let i = 0; i < 5; i++) {
        fbox(MAT.tube, 0.44, 0.014, 0.036, la, 0.56 + i * 0.05, outHalf + 0.02, 0.004, false);
      }
    }
    // ステータススクリーン(面の右上・発光)
    const sa = usable / 2 - 0.26;
    const sy = 0.1 + H * 0.68;
    fbox(MAT.dark, 0.4, 0.27, 0.035, sa, sy, outHalf + 0.012, 0.012, false);
    const scr = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.21),
      new THREE.MeshStandardMaterial({
        map: screenTex(m.kind), emissive: '#ffffff', emissiveMap: screenTex(m.kind),
        emissiveIntensity: 2.0, roughness: 0.35,
      }),
    );
    const [sx2, sz2] = faceXZ(rot, sa, outHalf + 0.032);
    scr.position.set(sx2, sy, sz2);
    scr.rotation.y = FACE_ROT_Y[rot];
    group.add(scr);
  }

  // 背面の供給配管(プロセス装置のみ)
  if (['clean', 'depo', 'etch', 'furnace', 'implant', 'metal', 'cmp'].includes(m.kind)) {
    for (let i = 0; i < 3; i++) {
      const along = -faceLen / 2 + 0.3 + i * 0.24;
      const [x, z] = faceXZ(rot, along, -(outHalf + 0.045));
      const pipe = mesh(GEO.cyl, MAT.tube, 0.055, H - 0.2, 0.055, x, 0.1 + (H - 0.2) / 2, z);
      group.add(pipe);
    }
  }

  // 種類ごとの意匠
  if (m.kind === 'litho') {
    group.add(rbox(m.w * 0.5, 0.4, m.h * 0.46, MAT.body, -m.w * 0.14, topY + 0.2, 0, 0.05));
    group.add(rbox(m.w * 0.2, 0.2, m.h * 0.3, MAT.tube, m.w * 0.24, topY + 0.1, 0, 0.04));
    topY += 0.4;
  } else if (m.kind === 'krf' || m.kind === 'arf' || m.kind === 'euv' || m.kind === 'euvhna') {
    // スキャナ: i線より大きな上部デッキ+光学塔。上位ティアほど塔が高い
    const tierH = m.kind === 'euvhna' ? 0.6 : m.kind === 'euv' ? 0.5 : m.kind === 'arf' ? 0.42 : 0.34;
    group.add(rbox(m.w * 0.62, 0.5, m.h * 0.56, MAT.body, -m.w * 0.1, topY + 0.25, 0, 0.06));
    for (const oz of [-0.3, 0.3]) {
      group.add(mesh(GEO.cyl, MAT.tube, 0.2, tierH, 0.2, m.w * 0.28, topY + 0.17, oz));
    }
    topY += 0.5;
  } else if (m.kind === 'furnace') {
    // 焼成中に赤熱するチューブ(マテリアルはこの装置専用にクローン)
    glowMat = MAT.tube.clone() as THREE.MeshStandardMaterial;
    const horizontal = m.w >= m.h;
    for (let i = 0; i < FURNACE_BATCH; i++) {
      const off = (i - 1) * 0.8;
      const tx = horizontal ? off : 0;
      const tz = horizontal ? 0 : off;
      group.add(mesh(GEO.cyl, glowMat, 0.36, 0.5, 0.36, tx, topY + 0.25, tz));
      const fv = buildFoup();
      fv.group.position.set(tx, topY + 0.5, tz);
      fv.group.visible = false;
      group.add(fv.group);
      slotFoups.push(fv);
    }
    topY += 0.5;
  } else if (m.kind === 'implant') {
    // ビームライン(横倒しの加速管)と高圧タンク
    const beam = mesh(GEO.cyl, MAT.tube, 0.26, m.w * 0.6, 0.26, -m.w * 0.08, topY + 0.14, 0);
    beam.rotation.z = Math.PI / 2;
    group.add(beam);
    group.add(mesh(GEO.sphere, MAT.tube, 0.42, 0.42, 0.42, m.w * 0.3, topY + 0.16, 0));
    topY += 0.3;
  } else if (m.kind === 'metal' || m.kind === 'cu') {
    // メタル成膜(Alスパッタ / Cuめっき槽)チャンバー2基
    for (const ox of [-0.42, 0.42]) {
      group.add(mesh(GEO.cyl, MAT.tube, 0.42, 0.3, 0.42, ox, topY + 0.15, 0));
    }
    topY += 0.3;
  } else if (m.kind === 'ald') {
    // ALD: 小型チャンバー+ガス供給塔
    group.add(rbox(0.5, 0.3, 0.5, MAT.panel, m.w * 0.14, topY + 0.15, 0, 0.04));
    group.add(mesh(GEO.cyl, MAT.tube, 0.1, 0.5, 0.1, -m.w * 0.18, topY + 0.25, 0));
    topY += 0.3;
  } else if (m.kind === 'cmp') {
    // 研磨プラテン(稼働中に回転)と研磨ヘッド
    spinner = mesh(GEO.cyl, MAT.tube, 0.9, 0.1, 0.9, 0, topY + 0.05, 0);
    // 回転が分かるようパッドのマーカーを載せる
    spinner.add(mesh(GEO.box, MAT.dark, 0.32, 1.3, 0.06, 0.22, 0.2, 0, false));
    group.add(spinner);
    group.add(mesh(GEO.cyl, MAT.dock, 0.3, 0.18, 0.3, 0.45, topY + 0.12, 0.35));
    topY += 0.18;
  } else if (m.kind === 'inspect') {
    group.add(mesh(GEO.cyl, MAT.tube, 0.3, 0.25, 0.3, 0, topY + 0.12, 0));
  } else if (m.kind === 'clean') {
    // 洗浄槽の蓋2つ
    for (const off of [-0.35, 0.35]) {
      group.add(mesh(GEO.cyl, MAT.tube, 0.42, 0.06, 0.42, off, topY + 0.03, 0, false));
    }
  } else if (m.kind === 'depo') {
    // ガスボックスと供給塔
    group.add(rbox(0.5, 0.32, 0.5, MAT.panel, m.w * 0.18, topY + 0.16, -m.h * 0.1, 0.04));
    group.add(mesh(GEO.cyl, MAT.tube, 0.08, 0.5, 0.08, -m.w * 0.2, topY + 0.25, 0));
    topY += 0.32;
  } else if (m.kind === 'etch') {
    // RFユニットとコイル
    group.add(rbox(0.6, 0.28, 0.6, MAT.panel, -m.w * 0.12, topY + 0.14, 0, 0.05));
    group.add(mesh(GEO.cyl, MAT.tube, 0.3, 0.14, 0.3, -m.w * 0.12, topY + 0.35, 0));
    topY += 0.42;
  }

  // 積層灯(3連レンズ)
  const lights: THREE.Mesh[] = [];
  if (def.placeable) {
    const lx = m.w / 2 - 0.22;
    const lz = -(m.h / 2 - 0.22);
    group.add(mesh(GEO.cyl, MAT.pole, 0.035, 0.5, 0.035, lx, topY + 0.25, lz, false));
    for (let i = 0; i < 3; i++) {
      const lens = new THREE.Mesh(
        GEO.cyl,
        new THREE.MeshStandardMaterial({ color: LIGHT_COLORS.off, roughness: 0.3 }),
      );
      lens.scale.set(0.11, 0.085, 0.11);
      lens.position.set(lx, topY + 0.53 - i * 0.095, lz);
      group.add(lens);
      lights.push(lens);
    }
  }

  // ロードポート(台座+SUSドックプレート)とドック上FOUP
  const portFoups: FoupView[] = [];
  for (const p of m.ports) {
    const px = p.col + 0.5 - (m.col + m.w / 2) + p.fx * 0.38;
    const pz = p.row + 0.5 - (m.row + m.h / 2) + p.fy * 0.38;
    const horizontal = p.fy !== 0;
    group.add(rbox(
      horizontal ? 0.5 : 0.3, 0.1, horizontal ? 0.3 : 0.5, MAT.plinth,
      px, 0.05, pz, 0.015,
    ));
    group.add(rbox(
      horizontal ? 0.42 : 0.24, 0.035, horizontal ? 0.24 : 0.42, MAT.tube,
      px, 0.117, pz, 0.008, false,
    ));
    // ポート上部のスライド扉(処理中に開く)。奥に暗いスロット
    if (def.placeable && m.kind !== 'stocker' && H >= 0.8) {
      const along = rot === 0 ? px : rot === 1 ? pz : rot === 2 ? -px : -pz;
      fbox(MAT.dark, 0.36, 0.42, 0.02, along, 0.44, outHalf + 0.006, 0.008, false);
      const door = fbox(MAT.panel, 0.42, 0.46, 0.035, along, 0.45, outHalf + 0.022, 0.012);
      doors.push({ mesh: door, closedY: 0.45 });
    }
    // 入出方向マーカー(小さな楔)
    const dir = p.io === 'out' ? 1 : -1;
    const wedge = mesh(
      GEO.cone, accentMat(p.io === 'out' ? '#7761a7' : '#7a8892'),
      0.1, 0.06, 0.1,
      px + p.fx * 0.2 * dir, 0.17, pz + p.fy * 0.2 * dir, false,
    );
    wedge.rotation.set(0, 0, 0);
    group.add(wedge);
    const fv = buildFoup();
    fv.group.position.set(px, FOUP_DOCK_Y - 0.1, pz);
    fv.group.visible = false;
    group.add(fv.group);
    portFoups.push(fv);
  }

  // 銘板と警告(ポストプロセスを通さないオーバーレイシーンに置くため、
  // 機体グループには入れずワールド座標で持つ。装置は設置後動かない)
  const plate = buildPlate();
  plate.sprite.position.set(m.col + m.w / 2, topY + 0.65, m.row + m.h / 2);
  const alert = buildAlertSprite();
  alert.position.set(m.col + m.w / 2, topY + 1.05, m.row + m.h / 2);
  alert.visible = false;

  return {
    group, lights, plate, alert, portFoups, slotFoups, topY,
    doors, doorT: 0, glowMat, spinner,
  };
}

function setLight(l: THREE.Mesh, color: string, on: boolean) {
  const mat = l.material as THREE.MeshStandardMaterial;
  mat.color.set(on ? color : LIGHT_COLORS.off);
  mat.emissive.set(on ? color : '#000000');
  mat.emissiveIntensity = on ? 2.2 : 0; // ブルームで灯りとして光らせる
}

// ---- ビークルビュー ----

interface VehicleView {
  group: THREE.Group;
  led: THREE.Mesh;
  cables: THREE.Mesh[];
  foup: FoupView;
  swing: THREE.Group; // 吊り下げ部(ケーブル+FOUP)。加減速で振り子運動する
  yaw: number;        // 表示ヨー(進行方向へなめらかに追従)
  sway: number;       // 振り子角
  swayV: number;
  lastX: number;
  lastZ: number;
  speed: number;
}

function buildVehicle(): VehicleView {
  const group = new THREE.Group();
  group.add(rbox(0.56, 0.2, 0.38, MAT.vehicle, 0, 0, 0, 0.05));
  group.add(rbox(0.44, 0.06, 0.26, MAT.hanger, 0, 0.13, 0, 0.02, false));
  const led = new THREE.Mesh(
    GEO.sphere,
    new THREE.MeshStandardMaterial({ color: '#c3ccd2', roughness: 0.4 }),
  );
  led.scale.setScalar(0.07);
  led.position.set(0.2, 0.06, 0.19);
  group.add(led);
  // 吊り下げ部は振り子用のサブグループにまとめる
  const swing = new THREE.Group();
  group.add(swing);
  const cables: THREE.Mesh[] = [];
  for (const ox of [-0.1, 0.1]) {
    const c = mesh(GEO.box, MAT.cable, 0.02, 1, 0.02, ox, 0, 0, false);
    c.visible = false;
    swing.add(c);
    cables.push(c);
  }
  const foup = buildFoup();
  foup.group.visible = false;
  swing.add(foup.group);
  return {
    group, led, cables, foup, swing,
    yaw: 0, sway: 0, swayV: 0, lastX: Number.NaN, lastZ: Number.NaN, speed: 0,
  };
}

// ---- メインの同期クラス ----

export class View3D {
  private machineViews = new Map<number, MachineView>();
  private vehicleViews = new Map<number, VehicleView>();
  private railGroup = new THREE.Group();
  private railVersion = -1;
  private heatMeshes = new Map<string, THREE.Mesh>();
  private heatGroup = new THREE.Group();
  private ghost: THREE.Group | null = null;
  private ghostKey = '';
  private ghostBody: THREE.Mesh | null = null;
  private hlMeshes = new Map<number, THREE.Mesh>(); // 装置種ハイライトの床リング
  private hlGroup = new THREE.Group();
  private previewPool: THREE.Mesh[] = [];
  private previewGroup = new THREE.Group();
  private eraseRing: THREE.Mesh;
  private selBox: THREE.LineSegments;
  private selGlow: THREE.Mesh;

  constructor(private scene: THREE.Scene, private overlay: THREE.Scene) {
    scene.add(this.railGroup);
    scene.add(this.heatGroup);
    scene.add(this.previewGroup);
    scene.add(this.hlGroup);

    this.eraseRing = new THREE.Mesh(GEO.torus, MAT.erase);
    this.eraseRing.rotation.x = Math.PI / 2;
    this.eraseRing.visible = false;
    scene.add(this.eraseRing);

    this.selBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(GEO.box),
      new THREE.LineBasicMaterial({ color: '#7761a7', transparent: true }),
    );
    this.selBox.visible = false;
    scene.add(this.selBox);

    this.selGlow = new THREE.Mesh(
      GEO.circle,
      new THREE.MeshBasicMaterial({
        color: '#7761a7', transparent: true, opacity: 0.3,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }),
    );
    this.selGlow.rotation.x = -Math.PI / 2;
    this.selGlow.visible = false;
    scene.add(this.selGlow);
  }

  private lastVsTime = 0;

  sync(game: Game, vs: ViewState, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    // アニメーション用のフレーム時間(タブ復帰などの大きな飛びはクランプ)
    const dt = Math.min(0.05, Math.max(0, vs.time - this.lastVsTime));
    this.lastVsTime = vs.time;
    this.syncMachines(game, vs, camera, dt);
    this.syncRails(game);
    this.syncVehicles(game, vs, dt);
    this.syncHeat(game, vs);
    this.syncOverlays(game, vs);
  }

  // ---- 装置 ----

  private syncMachines(game: Game, vs: ViewState, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, dt: number) {
    const seen = new Set<number>();
    for (const m of game.machines) {
      seen.add(m.id);
      let view = this.machineViews.get(m.id);
      if (!view) {
        view = buildMachine(m);
        this.machineViews.set(m.id, view);
        this.scene.add(view.group);
        this.overlay.add(view.plate.sprite, view.alert);
      }
      this.updateMachine(view, m, vs, camera, dt);
    }
    for (const [id, view] of this.machineViews) {
      if (!seen.has(id)) {
        this.scene.remove(view.group);
        this.overlay.remove(view.plate.sprite, view.alert);
        disposePlate(view.plate);
        this.machineViews.delete(id);
      }
    }
  }

  private updateMachine(view: MachineView, m: Machine, vs: ViewState, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, dt: number) {
    const def = MACHINE_DEFS[m.kind];
    const blink = Math.sin(vs.time * 7) > 0;

    // 積層灯
    if (view.lights.length === 3) {
      if (m.kind === 'stocker') {
        const full = m.storage.length >= 6;
        setLight(view.lights[0], LIGHT_COLORS.red, full);
        setLight(view.lights[1], LIGHT_COLORS.amber, false);
        setLight(view.lights[2], LIGHT_COLORS.green, !full);
      } else {
        // 赤=出力待ち滞留 / 黄=整備(PM)中または待機 / 緑=処理中。
        // 故障は廃止したので赤点滅は無い(整備中は黄が点滅)
        setLight(view.lights[0], LIGHT_COLORS.red, !m.pm && m.holdQueue.length > 0);
        setLight(
          view.lights[1], LIGHT_COLORS.amber,
          m.pm ? blink : (m.busy.length === 0 && m.holdQueue.length === 0),
        );
        setLight(view.lights[2], LIGHT_COLORS.green, !m.pm && m.busy.length > 0);
      }
    }

    // ポート上のFOUP
    m.ports.forEach((p, i) => setFoup(view.portFoups[i], p.foup));

    // ストッカー棚 / 炉チューブのFOUP
    if (m.kind === 'stocker') {
      view.slotFoups.forEach((fv, i) => setFoup(fv, m.storage[i] ?? null));
    } else if (m.kind === 'furnace') {
      const shown = m.busy.length > 0 ? m.busy : m.batch;
      view.slotFoups.forEach((fv, i) => setFoup(fv, shown[i] ?? null));
    }

    // 銘板
    const progress =
      m.busy.length > 0 ? 1 - m.procLeft / Math.max(def.procTime, 0.01) : 0;
    const status = plateStatus(m);
    const sig =
      `${status.text}|${Math.round(m.cleanliness * 20)}|${Math.round(progress * 24)}`;
    if (sig !== view.plate.sig) {
      view.plate.sig = sig;
      drawPlate(
        view.plate, def.accent, m.label, status.text, status.color,
        def.placeable && m.kind !== 'stocker' ? m.cleanliness : null,
        progress,
      );
    }

    // 滞留警告(経路なし/装置未設置/全台停止。距離フェードの対象外で常に見える)
    view.alert.visible = !!m.stall && Math.sin(vs.time * 5) > -0.3;

    // 銘板の距離フェード: ズームアウトすると小さな銘板が密集して読めなく
    // なるので、遠いものは透明にして視界のクラッタを減らす。選択中は無視。
    // 2Dモード(直交カメラ)は物理距離が一定のため、代わりにズーム量を使う
    const plateMat = view.plate.sprite.material as THREE.SpriteMaterial;
    if (vs.selected === m) {
      plateMat.opacity = 1;
      view.plate.sprite.visible = true;
    } else {
      const dist =
        camera.type === 'OrthographicCamera'
          ? ORTHO_FADE_BASE_DIST / camera.zoom
          : camera.position.distanceTo(view.plate.sprite.position);
      const t = clamp01((dist - PLATE_FADE_NEAR) / (PLATE_FADE_FAR - PLATE_FADE_NEAR));
      plateMat.opacity = 1 - t;
      view.plate.sprite.visible = t < 0.98;
    }

    // ---- モーション(V4) ----
    // ポート扉: 処理中(炉は装填中も)にスライドして開く
    const doorTarget = m.busy.length > 0 || m.batch.length > 0 ? 1 : 0;
    view.doorT += (doorTarget - view.doorT) * Math.min(1, dt * 4);
    for (const d of view.doors) d.mesh.position.y = d.closedY + view.doorT * 0.36;
    // 炉の赤熱グロー(焼成中だけゆっくり脈動)
    if (view.glowMat) {
      const k = m.busy.length > 0 ? 0.5 + 0.3 * Math.sin(vs.time * 2.6) : 0;
      view.glowMat.emissive.set('#ff8a4d');
      // 点灯はゆっくり、消灯は速めに(残熱が長引くと故障と紛らわしい)
      view.glowMat.emissiveIntensity +=
        (k - view.glowMat.emissiveIntensity) * Math.min(1, dt * (k > 0 ? 3 : 8));
    }
    // CMPプラテンの回転(稼働中は高速)
    if (view.spinner) {
      view.spinner.rotation.y += dt * (m.busy.length > 0 ? 5 : 0.4);
    }
    // FOUPの出現ポップ
    for (const fv of view.portFoups) animFoupPop(fv, dt);
    for (const fv of view.slotFoups) animFoupPop(fv, dt);
  }

  // ---- レール ----

  private syncRails(game: Game) {
    if (game.rail.version === this.railVersion) return;
    this.railVersion = game.rail.version;
    this.railGroup.clear();

    for (const [a, b] of game.rail.allEdges()) {
      const pa = parseKey(a);
      const pb = parseKey(b);
      const ax = pa.c + 0.5;
      const az = pa.r + 0.5;
      const bx = pb.c + 0.5;
      const bz = pb.r + 0.5;
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      const horizontal = pa.r === pb.r;
      // 桁
      this.railGroup.add(mesh(
        GEO.box, MAT.railBeam,
        horizontal ? 1.14 : 0.16, 0.1, horizontal ? 0.16 : 1.14,
        mx, RAIL_Y, mz,
      ));
      this.railGroup.add(mesh(
        GEO.box, MAT.railTop,
        horizontal ? 1.0 : 0.09, 0.035, horizontal ? 0.09 : 1.0,
        mx, RAIL_Y + 0.06, mz, false,
      ));
      // 進行方向シェブロン
      const dx = bx - ax;
      const dz = bz - az;
      const cone = mesh(GEO.cone, MAT.chevron, 0.12, 0.17, 0.1, mx, RAIL_Y + 0.09, mz, false);
      if (dx > 0) cone.rotation.z = -Math.PI / 2;
      else if (dx < 0) cone.rotation.z = Math.PI / 2;
      else if (dz > 0) cone.rotation.x = Math.PI / 2;
      else cone.rotation.x = -Math.PI / 2;
      this.railGroup.add(cone);
    }
    // 吊り金具(FFU天井まで届く支柱)
    const hangLen = CEIL_Y - RAIL_Y - 0.05;
    for (const k of game.rail.allNodes()) {
      const { c, r } = parseKey(k);
      this.railGroup.add(mesh(
        GEO.box, MAT.hanger, 0.045, hangLen, 0.045,
        c + 0.5, RAIL_Y + 0.05 + hangLen / 2, r + 0.5, false,
      ));
    }
  }

  // ---- ビークル ----

  private syncVehicles(game: Game, vs: ViewState, dt: number) {
    const seen = new Set<number>();
    for (const v of game.fleet.vehicles) {
      seen.add(v.id);
      let view = this.vehicleViews.get(v.id);
      if (!view) {
        view = buildVehicle();
        this.vehicleViews.set(v.id, view);
        this.scene.add(view.group);
      }
      this.updateVehicle(view, v, vs, dt);
    }
    for (const [id, view] of this.vehicleViews) {
      if (!seen.has(id)) {
        this.scene.remove(view.group);
        this.vehicleViews.delete(id);
      }
    }
  }

  private updateVehicle(view: VehicleView, v: Vehicle, vs: ViewState, dt: number) {
    const p = vehiclePos(v);
    const px = p.x / TILE;
    const pz = p.y / TILE;
    view.group.position.set(px, RAIL_Y + 0.16, pz);

    // ヨーは進行方向へなめらかに追従し、カーブでは内側へ軽くバンクする
    let yawDelta = 0;
    if (v.target) {
      const a = parseKey(v.tile);
      const b = parseKey(v.target);
      const targetYaw = -Math.atan2(b.r - a.r, b.c - a.c);
      let dy = targetYaw - view.yaw;
      dy = Math.atan2(Math.sin(dy), Math.cos(dy));
      view.yaw += dy * Math.min(1, dt * 10);
      yawDelta = dy;
    }
    view.group.rotation.y = view.yaw;
    const bank = THREE.MathUtils.clamp(yawDelta * 0.5, -0.16, 0.16);
    view.group.rotation.z += (bank - view.group.rotation.z) * Math.min(1, dt * 8);

    // 吊り下げFOUPの振り子: 加減速に遅れて揺れるバネ
    if (dt > 0) {
      const spd = Number.isNaN(view.lastX)
        ? 0
        : Math.hypot(px - view.lastX, pz - view.lastZ) / dt;
      const accel = (spd - view.speed) / Math.max(dt, 1e-3);
      view.speed = spd;
      view.swayV += (-view.sway * 40 - view.swayV * 6 - accel * 0.05) * dt;
      view.sway = THREE.MathUtils.clamp(view.sway + view.swayV * dt, -0.28, 0.28);
    }
    view.lastX = px;
    view.lastZ = pz;
    view.swing.rotation.z = view.sway;

    // 状態LED
    const ledMat = view.led.material as THREE.MeshStandardMaterial;
    if (v.stuck) {
      const on = Math.sin(vs.time * 8) > 0;
      ledMat.color.set(on ? '#cc4f44' : '#c3ccd2');
      ledMat.emissive.set(on ? '#cc4f44' : '#000');
    } else if (v.job) {
      ledMat.color.set('#7761a7');
      ledMat.emissive.set('#7761a7');
      ledMat.emissiveIntensity = 0.7;
    } else {
      ledMat.color.set('#c3ccd2');
      ledMat.emissive.set('#000');
    }

    // ホイスト(ワイヤー + 吊り下げFOUP)。状態遷移のタイミング(v.hoistT)は
    // シム側で管理されたまま、見た目の落下量だけイーズイン/アウトで滑らかにする
    const maxDrop = RAIL_Y + 0.16 - 0.1 - FOUP_DOCK_Y - 0.2;
    const drop = easeInOutCubic(v.hoistT) * maxDrop;
    const hoisting = drop > 0.02;
    const showFoup = v.carrying !== null;
    for (const c of view.cables) {
      c.visible = hoisting;
      if (hoisting) {
        c.scale.y = drop + 0.14;
        c.position.y = -0.1 - (drop + 0.14) / 2;
      }
    }
    view.foup.group.visible = showFoup;
    if (showFoup) {
      setFoup(view.foup, v.carrying);
      view.foup.group.position.set(0, -FOUP_UNDER_VEH - drop, 0);
      animFoupPop(view.foup, dt);
    }
  }

  // ---- 渋滞ヒート ----

  private syncHeat(game: Game, vs: ViewState) {
    this.heatGroup.visible = vs.showHeat;
    if (!vs.showHeat) return;
    const { heat, heatMax } = game.fleet;
    const seen = new Set<string>();
    for (const [k, value] of heat) {
      const t = Math.min(1, value / Math.max(heatMax, 3));
      if (t < 0.06) continue;
      seen.add(k);
      let m = this.heatMeshes.get(k);
      if (!m) {
        m = new THREE.Mesh(
          GEO.circle,
          new THREE.MeshBasicMaterial({
            transparent: true, depthWrite: false, color: '#d99a2b',
          }),
        );
        m.rotation.x = -Math.PI / 2;
        const { c, r } = parseKey(k);
        m.position.set(c + 0.5, 0.03, r + 0.5);
        this.heatMeshes.set(k, m);
        this.heatGroup.add(m);
      }
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.set(new THREE.Color('#d99a2b').lerp(new THREE.Color('#cc4f44'), t));
      mat.opacity = 0.22 + 0.45 * t;
      m.scale.setScalar(0.9 + 0.8 * t);
    }
    for (const [k, m] of this.heatMeshes) {
      if (!seen.has(k)) {
        this.heatGroup.remove(m);
        (m.material as THREE.Material).dispose();
        this.heatMeshes.delete(k);
      }
    }
  }

  // ---- ツールオーバーレイ ----

  private syncOverlays(game: Game, vs: ViewState) {
    // 選択ハイライト: 枠線 + 床のグロー(どちらもパルスさせて視認性を上げる)
    const sel = vs.selected;
    this.selBox.visible = !!sel;
    this.selGlow.visible = !!sel;
    if (sel) {
      const accent = MACHINE_DEFS[sel.kind].accent;
      const pulse = 0.5 + 0.5 * Math.sin(vs.time * 3);

      const h = BODY_H[sel.kind] + 0.7;
      this.selBox.scale.set(sel.w + 0.1, h, sel.h + 0.1);
      this.selBox.position.set(sel.col + sel.w / 2, h / 2, sel.row + sel.h / 2);
      const boxMat = this.selBox.material as THREE.LineBasicMaterial;
      boxMat.color.set(accent);
      boxMat.opacity = 0.65 + 0.35 * pulse;

      const radius = Math.max(sel.w, sel.h) / 2 + 0.35;
      this.selGlow.scale.setScalar((radius + 0.05 * pulse) * 2);
      this.selGlow.position.set(sel.col + sel.w / 2, 0.025, sel.row + sel.h / 2);
      const glowMat = this.selGlow.material as THREE.MeshBasicMaterial;
      glowMat.color.set(accent);
      glowMat.opacity = 0.2 + 0.16 * pulse;
    }

    // 設置ゴースト
    const placing = vs.tool.mode === 'place' && vs.tool.kind && vs.cursor.inside;
    const key = placing ? `${vs.tool.kind}|${vs.toolRot}` : '';
    if (key !== this.ghostKey) {
      this.ghostKey = key;
      if (this.ghost) {
        this.scene.remove(this.ghost);
        this.ghost = null;
        this.ghostBody = null;
      }
      if (placing) {
        const def = MACHINE_DEFS[vs.tool.kind!];
        const { w, h } = rotSize(def, vs.toolRot);
        const g = new THREE.Group();
        const H = BODY_H[vs.tool.kind!];
        this.ghostBody = mesh(GEO.box, MAT.ghostOk, w - 0.16, H, h - 0.16, 0, 0.1 + H / 2, 0, false);
        g.add(this.ghostBody);
        for (const p of rotPorts(def, vs.toolRot)) {
          const dot = mesh(
            GEO.sphere, accentMat(p.io === 'out' ? '#7761a7' : '#7a8892'),
            0.16, 0.16, 0.16,
            p.dx + 0.5 - w / 2 + p.fx * 0.38, 0.15,
            p.dy + 0.5 - h / 2 + p.fy * 0.38, false,
          );
          g.add(dot);
        }
        this.ghost = g;
        this.scene.add(g);
      }
    }
    if (this.ghost && placing) {
      const def = MACHINE_DEFS[vs.tool.kind!];
      const { w, h } = rotSize(def, vs.toolRot);
      this.ghost.position.set(vs.cursor.c + w / 2, 0, vs.cursor.r + h / 2);
      const ok =
        game.canPlace(vs.tool.kind!, vs.cursor.c, vs.cursor.r, vs.toolRot) &&
        game.canAfford(vs.tool.kind!);
      this.ghostBody!.material = ok ? MAT.ghostOk : MAT.ghostNg;
      this.ghost.visible = true;
    } else if (this.ghost) {
      this.ghost.visible = false;
    }

    // 装置種ハイライト(工程フローパネル⇔フロア連動): 該当装置の足元に
    // パルスするリングを表示し、どの装置群の話かをフロア上で示す
    const hk = vs.highlightKind;
    this.hlGroup.visible = !!hk;
    if (hk) {
      const pulse = 0.5 + 0.5 * Math.sin(vs.time * 4);
      const seen = new Set<number>();
      for (const m of game.machines) {
        // ティア違いの装置(i線/DUV)も同じ工程としてまとめて光らせる
        if (servesOf(m.kind) !== hk) continue;
        seen.add(m.id);
        let ring = this.hlMeshes.get(m.id);
        if (!ring) {
          ring = new THREE.Mesh(
            GEO.torus,
            new THREE.MeshBasicMaterial({
              color: MACHINE_DEFS[hk].accent, transparent: true,
              depthWrite: false,
            }),
          );
          ring.rotation.x = Math.PI / 2;
          this.hlMeshes.set(m.id, ring);
          this.hlGroup.add(ring);
        }
        (ring.material as THREE.MeshBasicMaterial).color.set(MACHINE_DEFS[hk].accent);
        (ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.35 * pulse;
        const radius = Math.max(m.w, m.h) + 0.5 + 0.12 * pulse;
        ring.scale.set(radius, radius, 1);
        ring.position.set(m.col + m.w / 2, 0.05, m.row + m.h / 2);
      }
      for (const [id, ring] of this.hlMeshes) {
        if (!seen.has(id)) {
          this.hlGroup.remove(ring);
          (ring.material as THREE.Material).dispose();
          this.hlMeshes.delete(id);
        }
      }
    }

    // レール敷設プレビュー
    const path = vs.railPath;
    let used = 0;
    for (let i = 1; i < path.length; i++) {
      const a = parseKey(path[i - 1]);
      const b = parseKey(path[i]);
      let seg = this.previewPool[used];
      if (!seg) {
        seg = mesh(GEO.box, MAT.preview, 1, 1, 1, 0, 0, 0, false);
        this.previewPool.push(seg);
        this.previewGroup.add(seg);
      }
      const horizontal = a.r === b.r;
      seg.scale.set(horizontal ? 1.1 : 0.14, 0.09, horizontal ? 0.14 : 1.1);
      seg.position.set((a.c + b.c) / 2 + 0.5, RAIL_Y, (a.r + b.r) / 2 + 0.5);
      seg.visible = true;
      used++;
    }
    // 敷設開始マーカー(パスが1タイルだけのとき)
    if (path.length === 1) {
      let seg = this.previewPool[used];
      if (!seg) {
        seg = mesh(GEO.box, MAT.preview, 1, 1, 1, 0, 0, 0, false);
        this.previewPool.push(seg);
        this.previewGroup.add(seg);
      }
      const { c, r } = parseKey(path[0]);
      seg.scale.set(0.3, 0.09, 0.3);
      seg.position.set(c + 0.5, RAIL_Y, r + 0.5);
      seg.visible = true;
      used++;
    }
    for (let i = used; i < this.previewPool.length; i++) {
      this.previewPool[i].visible = false;
    }

    // レール撤去カーソル
    const erasing = vs.tool.mode === 'railErase' && vs.cursor.inside;
    this.eraseRing.visible = erasing;
    if (erasing) {
      this.eraseRing.position.set(vs.cursor.c + 0.5, RAIL_Y, vs.cursor.r + 0.5);
    }
  }
}

function plateStatus(m: Machine): { text: string; color: string } {
  if (m.pm) return { text: `整備中 ${Math.ceil(m.pmLeft)}s`, color: '#b07f19' };
  if (m.kind === 'stocker') {
    return { text: `保管 ${m.storage.length}/6`, color: '#5d6d76' };
  }
  if (m.kind === 'load') return { text: '払い出し', color: '#5d6d76' };
  if (m.kind === 'ship') return { text: '出荷受入', color: '#5d6d76' };
  if (m.busy.length > 0) {
    return {
      text: m.kind === 'furnace' ? `処理中 ${m.busy.length}/${FURNACE_BATCH}` : '処理中',
      color: '#2f7a45',
    };
  }
  if (m.kind === 'furnace' && m.batch.length > 0) {
    return { text: `装填 ${m.batch.length}/${FURNACE_BATCH}`, color: '#5d6d76' };
  }
  if (m.holdQueue.length > 0) return { text: '出力待ち', color: '#b07f19' };
  return { text: '待機', color: '#7a8892' };
}

function disposePlate(plate: Plate) {
  plate.tex.dispose();
  (plate.sprite.material as THREE.SpriteMaterial).dispose();
}
