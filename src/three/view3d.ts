// ゲーム状態 → 3Dシーンの同期層。
// 装置(2.5階建ての白い筐体+積層灯+銘板)、天井レール、OHTビークル、
// FOUP、渋滞ヒート、ツールオーバーレイをフレームごとに反映する。

import * as THREE from 'three';
import {
  TILE, MACHINE_DEFS, PRODUCTS, FURNACE_BATCH,
  rotSize, rotPorts,
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

// 装置本体の高さ [ユニット]
const BODY_H: Record<MachineKind, number> = {
  load: 0.45, ship: 0.45,
  clean: 1.0, depo: 1.15, litho: 1.2, etch: 1.15,
  furnace: 1.05, inspect: 0.7, stocker: 1.85,
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

const MAT = {
  body: new THREE.MeshStandardMaterial({ color: '#fafbfd', roughness: 0.6, metalness: 0.04 }),
  plinth: new THREE.MeshStandardMaterial({ color: '#ccd3d8', roughness: 0.85 }),
  dock: new THREE.MeshStandardMaterial({ color: '#c2cad0', roughness: 0.7 }),
  tube: new THREE.MeshStandardMaterial({ color: '#e8e2df', roughness: 0.4, metalness: 0.25 }),
  railBeam: new THREE.MeshStandardMaterial({ color: '#9aa5ad', roughness: 0.45, metalness: 0.5 }),
  railTop: new THREE.MeshStandardMaterial({ color: '#eef1f3', roughness: 0.35, metalness: 0.2 }),
  hanger: new THREE.MeshStandardMaterial({ color: '#7d8892', roughness: 0.6, metalness: 0.4 }),
  chevron: new THREE.MeshStandardMaterial({ color: '#88949c', roughness: 0.55 }),
  vehicle: new THREE.MeshStandardMaterial({ color: '#f7f9fa', roughness: 0.4, metalness: 0.15 }),
  cable: new THREE.MeshStandardMaterial({ color: '#8b969e', roughness: 0.7 }),
  foupBody: new THREE.MeshStandardMaterial({
    color: '#8d6fb5', roughness: 0.3, metalness: 0.05,
    transparent: true, opacity: 0.88,
  }),
  foupLid: new THREE.MeshStandardMaterial({ color: '#d3c7e8', roughness: 0.4 }),
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

// ---- FOUP ----

interface FoupView {
  group: THREE.Group;
  band: THREE.Mesh;
}

function buildFoup(): FoupView {
  const group = new THREE.Group();
  group.add(mesh(GEO.box, MAT.foupBody, 0.3, 0.24, 0.3, 0, 0.12, 0));
  group.add(mesh(GEO.box, MAT.foupLid, 0.26, 0.045, 0.26, 0, 0.255, 0, false));
  const band = mesh(GEO.box, accentMat('#888'), 0.31, 0.05, 0.31, 0, 0.045, 0, false);
  group.add(band);
  group.add(mesh(GEO.box, MAT.foupLid, 0.12, 0.04, 0.12, 0, 0.29, 0, false)); // 把持部
  return { group, band };
}

function setFoup(view: FoupView, lot: Lot | null) {
  view.group.visible = lot !== null;
  if (lot) view.band.material = accentMat(PRODUCTS[lot.product].color);
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
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true }),
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
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
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
}

function buildMachine(m: Machine): MachineView {
  const def = MACHINE_DEFS[m.kind];
  const group = new THREE.Group();
  group.position.set(m.col + m.w / 2, 0, m.row + m.h / 2);
  const H = BODY_H[m.kind];
  let topY = 0.1 + H;

  group.add(mesh(GEO.box, MAT.plinth, m.w - 0.06, 0.1, m.h - 0.06, 0, 0.05, 0));
  const body = mesh(GEO.box, MAT.body, m.w - 0.18, H, m.h - 0.18, 0, 0.1 + H / 2, 0);
  body.receiveShadow = true;
  group.add(body);

  // アクセント帯(ポート面)
  const face = m.rot % 4;
  const am = accentMat(def.accent);
  const bw = m.w - 0.26;
  const bh = m.h - 0.26;
  if (face === 0) group.add(mesh(GEO.box, am, bw, 0.12, 0.04, 0, 0.34, (m.h - 0.18) / 2 + 0.01, false));
  else if (face === 1) group.add(mesh(GEO.box, am, 0.04, 0.12, bh, -((m.w - 0.18) / 2 + 0.01), 0.34, 0, false));
  else if (face === 2) group.add(mesh(GEO.box, am, bw, 0.12, 0.04, 0, 0.34, -((m.h - 0.18) / 2 + 0.01), false));
  else group.add(mesh(GEO.box, am, 0.04, 0.12, bh, (m.w - 0.18) / 2 + 0.01, 0.34, 0, false));

  const slotFoups: FoupView[] = [];

  // 種類ごとの意匠
  if (m.kind === 'litho') {
    group.add(mesh(GEO.box, MAT.body, m.w * 0.52, 0.42, m.h * 0.5, -m.w * 0.14, topY + 0.21, 0));
    group.add(mesh(GEO.box, MAT.tube, m.w * 0.2, 0.2, m.h * 0.3, m.w * 0.24, topY + 0.1, 0));
    topY += 0.42;
  } else if (m.kind === 'furnace') {
    const horizontal = m.w >= m.h;
    for (let i = 0; i < FURNACE_BATCH; i++) {
      const off = (i - 1) * 0.8;
      const tx = horizontal ? off : 0;
      const tz = horizontal ? 0 : off;
      group.add(mesh(GEO.cyl, MAT.tube, 0.36, 0.5, 0.36, tx, topY + 0.25, tz));
      const fv = buildFoup();
      fv.group.position.set(tx, topY + 0.5, tz);
      fv.group.visible = false;
      group.add(fv.group);
      slotFoups.push(fv);
    }
    topY += 0.5;
  } else if (m.kind === 'stocker') {
    for (let i = 0; i < 6; i++) {
      const fv = buildFoup();
      fv.group.position.set(((i % 3) - 1) * 0.55, topY, (Math.floor(i / 3) - 0.5) * 0.55);
      fv.group.visible = false;
      group.add(fv.group);
      slotFoups.push(fv);
    }
  } else if (m.kind === 'inspect') {
    group.add(mesh(GEO.cyl, MAT.tube, 0.3, 0.25, 0.3, 0, topY + 0.12, 0));
  }

  // 積層灯
  const lights: THREE.Mesh[] = [];
  if (def.placeable) {
    const lx = m.w / 2 - 0.22;
    const lz = -(m.h / 2 - 0.22);
    group.add(mesh(GEO.cyl, MAT.pole, 0.04, 0.46, 0.04, lx, topY + 0.23, lz, false));
    for (let i = 0; i < 3; i++) {
      const s = new THREE.Mesh(
        GEO.sphere,
        new THREE.MeshStandardMaterial({ color: LIGHT_COLORS.off, roughness: 0.4 }),
      );
      s.scale.setScalar(0.11);
      s.position.set(lx, topY + 0.5 - i * 0.13, lz);
      group.add(s);
      lights.push(s);
    }
  }

  // ロードポートとドック上FOUP
  const portFoups: FoupView[] = [];
  for (const p of m.ports) {
    const px = p.col + 0.5 - (m.col + m.w / 2) + p.fx * 0.38;
    const pz = p.row + 0.5 - (m.row + m.h / 2) + p.fy * 0.38;
    const horizontal = p.fy !== 0;
    group.add(mesh(
      GEO.box, MAT.dock,
      horizontal ? 0.52 : 0.3, 0.14, horizontal ? 0.3 : 0.52,
      px, 0.07, pz,
    ));
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

  // 銘板と警告
  const plate = buildPlate();
  plate.sprite.position.set(0, topY + 0.65, 0);
  group.add(plate.sprite);
  const alert = buildAlertSprite();
  alert.position.set(0, topY + 1.05, 0);
  alert.visible = false;
  group.add(alert);

  return { group, lights, plate, alert, portFoups, slotFoups, topY };
}

function setLight(l: THREE.Mesh, color: string, on: boolean) {
  const mat = l.material as THREE.MeshStandardMaterial;
  mat.color.set(on ? color : LIGHT_COLORS.off);
  mat.emissive.set(on ? color : '#000000');
  mat.emissiveIntensity = on ? 0.85 : 0;
}

// ---- ビークルビュー ----

interface VehicleView {
  group: THREE.Group;
  led: THREE.Mesh;
  cables: THREE.Mesh[];
  foup: FoupView;
}

function buildVehicle(): VehicleView {
  const group = new THREE.Group();
  group.add(mesh(GEO.box, MAT.vehicle, 0.54, 0.2, 0.36, 0, 0, 0));
  group.add(mesh(GEO.box, MAT.hanger, 0.44, 0.06, 0.26, 0, 0.13, 0, false));
  const led = new THREE.Mesh(
    GEO.sphere,
    new THREE.MeshStandardMaterial({ color: '#c3ccd2', roughness: 0.4 }),
  );
  led.scale.setScalar(0.07);
  led.position.set(0.2, 0.06, 0.19);
  group.add(led);
  const cables: THREE.Mesh[] = [];
  for (const ox of [-0.1, 0.1]) {
    const c = mesh(GEO.box, MAT.cable, 0.02, 1, 0.02, ox, 0, 0, false);
    c.visible = false;
    group.add(c);
    cables.push(c);
  }
  const foup = buildFoup();
  foup.group.visible = false;
  group.add(foup.group);
  return { group, led, cables, foup };
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
  private previewPool: THREE.Mesh[] = [];
  private previewGroup = new THREE.Group();
  private eraseRing: THREE.Mesh;
  private selBox: THREE.LineSegments;

  constructor(private scene: THREE.Scene) {
    scene.add(this.railGroup);
    scene.add(this.heatGroup);
    scene.add(this.previewGroup);

    this.eraseRing = new THREE.Mesh(GEO.torus, MAT.erase);
    this.eraseRing.rotation.x = Math.PI / 2;
    this.eraseRing.visible = false;
    scene.add(this.eraseRing);

    this.selBox = new THREE.LineSegments(
      new THREE.EdgesGeometry(GEO.box),
      new THREE.LineBasicMaterial({ color: '#7761a7' }),
    );
    this.selBox.visible = false;
    scene.add(this.selBox);
  }

  sync(game: Game, vs: ViewState) {
    this.syncMachines(game, vs);
    this.syncRails(game);
    this.syncVehicles(game, vs);
    this.syncHeat(game, vs);
    this.syncOverlays(game, vs);
  }

  // ---- 装置 ----

  private syncMachines(game: Game, vs: ViewState) {
    const seen = new Set<number>();
    for (const m of game.machines) {
      seen.add(m.id);
      let view = this.machineViews.get(m.id);
      if (!view) {
        view = buildMachine(m);
        this.machineViews.set(m.id, view);
        this.scene.add(view.group);
      }
      this.updateMachine(view, m, vs);
    }
    for (const [id, view] of this.machineViews) {
      if (!seen.has(id)) {
        this.scene.remove(view.group);
        disposePlate(view.plate);
        this.machineViews.delete(id);
      }
    }
  }

  private updateMachine(view: MachineView, m: Machine, vs: ViewState) {
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
        setLight(
          view.lights[0], LIGHT_COLORS.red,
          m.broken ? (m.repairLeft > 0 || blink) : m.maintLeft > 0 || m.holdQueue.length > 0,
        );
        setLight(
          view.lights[1], LIGHT_COLORS.amber,
          !m.broken && m.maintLeft === 0 && m.busy.length === 0 && m.holdQueue.length === 0,
        );
        setLight(view.lights[2], LIGHT_COLORS.green, m.busy.length > 0);
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

    // 経路なし警告
    view.alert.visible = m.noRoute && Math.sin(vs.time * 5) > -0.3;
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
    // 吊り金具(支柱スタブ)
    for (const k of game.rail.allNodes()) {
      const { c, r } = parseKey(k);
      this.railGroup.add(mesh(
        GEO.box, MAT.hanger, 0.045, 0.28, 0.045,
        c + 0.5, RAIL_Y + 0.19, r + 0.5, false,
      ));
    }
  }

  // ---- ビークル ----

  private syncVehicles(game: Game, vs: ViewState) {
    const seen = new Set<number>();
    for (const v of game.fleet.vehicles) {
      seen.add(v.id);
      let view = this.vehicleViews.get(v.id);
      if (!view) {
        view = buildVehicle();
        this.vehicleViews.set(v.id, view);
        this.scene.add(view.group);
      }
      this.updateVehicle(view, v, vs);
    }
    for (const [id, view] of this.vehicleViews) {
      if (!seen.has(id)) {
        this.scene.remove(view.group);
        this.vehicleViews.delete(id);
      }
    }
  }

  private updateVehicle(view: VehicleView, v: Vehicle, vs: ViewState) {
    const p = vehiclePos(v);
    view.group.position.set(p.x / TILE, RAIL_Y + 0.16, p.y / TILE);
    if (v.target) {
      const a = parseKey(v.tile);
      const b = parseKey(v.target);
      view.group.rotation.y = -Math.atan2(b.r - a.r, b.c - a.c);
    }

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

    // ホイスト(ワイヤー + 吊り下げFOUP)
    const maxDrop = RAIL_Y + 0.16 - 0.1 - FOUP_DOCK_Y - 0.2;
    const drop = v.hoistT * maxDrop;
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
    // 選択枠
    const sel = vs.selected;
    this.selBox.visible = !!sel;
    if (sel) {
      const h = BODY_H[sel.kind] + 0.7;
      this.selBox.scale.set(sel.w + 0.1, h, sel.h + 0.1);
      this.selBox.position.set(sel.col + sel.w / 2, h / 2, sel.row + sel.h / 2);
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
      const ok = game.canPlace(vs.tool.kind!, vs.cursor.c, vs.cursor.r, vs.toolRot);
      this.ghostBody!.material = ok ? MAT.ghostOk : MAT.ghostNg;
      this.ghost.visible = true;
    } else if (this.ghost) {
      this.ghost.visible = false;
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
  if (m.broken && m.repairLeft > 0) {
    return { text: `修理中 ${Math.ceil(m.repairLeft)}s`, color: '#cc4f44' };
  }
  if (m.broken) return { text: '故障', color: '#cc4f44' };
  if (m.maintLeft > 0) {
    return { text: `整備中 ${Math.ceil(m.maintLeft)}s`, color: '#b07f19' };
  }
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
