// Three.js シーン基盤: レンダラー・軌道カメラ・照明・クリーンルーム建築
// (床・壁・FFU天井)・ポストプロセス・タイルピッキング。
// ワールド座標の単位は「1タイル = 1」(x=列, z=行, y=上)。
//
// 描画は「精密ジオラマ」路線: AgXトーンマッピング + IBL + GTAO(AO) +
// ブルーム + ティルトシフトで、白基調のクリーンルームをミニチュア写真の
// ように見せる。?lowfx ではポストプロセスと影を全て切って直接描画する。
//
// カメラは透視(3D)と直交・真上固定(2D)の2つを切り替えて使う。同じ
// OrbitControls インスタンスの .object を差し替える方式で、パン位置や
// ズームはカメラごとに保持されるため、モード切替のたびに元の見た目に戻る。
//
// 壁は「内向きの片面ポリゴン」なので、カメラの背後に来た壁は自動的に
// 消える(ドールハウス表示)。FFU天井も下向き片面で、見下ろし時は透ける。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { HorizontalTiltShiftShader } from 'three/examples/jsm/shaders/HorizontalTiltShiftShader.js';
import { VerticalTiltShiftShader } from 'three/examples/jsm/shaders/VerticalTiltShiftShader.js';
import { MAP_COLS, MAP_ROWS, CEIL_Y } from '../config';

export type ViewMode = '2d' | '3d';

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  // ポストプロセスの影響を受けないオーバーレイ(銘板・警告アイコン用)。
  // AOやティルトシフトに潰されず常に鮮明に描かれる
  overlay: THREE.Scene;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera; // 現在アクティブなカメラ
  controls: OrbitControls;
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  render: () => void;
  resize: () => void;
  // 画面座標 → 床平面(y=0)上のタイル
  pickTile: (clientX: number, clientY: number) => {
    c: number; r: number; inside: boolean;
  };
  // ワールド座標 → 画面px
  worldToScreen: (x: number, y: number, z: number) => { x: number; y: number };
}

const ORTHO_HEIGHT = 30;  // 直交カメラの固定高度(ズームは camera.zoom で行う)
const ORTHO_VIEW_SIZE = 11; // 直交カメラの初期視野半高さ [ワールド単位]
const TILT_SHIFT_AMOUNT = 1.2; // ティルトシフトの強さ [px](ジオラマ感の味付け)

export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  // 描画品質: ?fx=high(既定: AO+ブルーム+ティルトシフト) / ?fx=med(ブルームのみ)
  // / ?fx=low(ポストプロセス・影・AAなし。旧 ?lowfx と同じ)
  const params = new URLSearchParams(location.search);
  const fx = params.has('lowfx') ? 'low' : (params.get('fx') ?? 'high');
  const lowfx = fx === 'low';
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !lowfx,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(lowfx ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = !lowfx;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 0.9;
  RectAreaLightUniformsLib.init();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#c6cbcf');
  scene.fog = new THREE.Fog('#c6cbcf', 90, 170);
  const overlay = new THREE.Scene();

  // IBL: 室内環境マップ。白い筐体や金属の質感はほぼこれで決まる
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;

  const cx = MAP_COLS / 2;
  const cz = MAP_ROWS / 2;

  // ---- 3Dカメラ(透視) ----
  const perspCam = new THREE.PerspectiveCamera(
    40, window.innerWidth / window.innerHeight, 0.1, 300,
  );
  perspCam.position.set(cx, 25, cz + 15.5);

  // ---- 2Dカメラ(直交・真上固定)----
  const aspect0 = window.innerWidth / window.innerHeight;
  const orthoCam = new THREE.OrthographicCamera(
    -ORTHO_VIEW_SIZE * aspect0, ORTHO_VIEW_SIZE * aspect0,
    ORTHO_VIEW_SIZE, -ORTHO_VIEW_SIZE, 0.1, 300,
  );
  orthoCam.position.set(cx, ORTHO_HEIGHT, cz);
  orthoCam.zoom = 1;
  orthoCam.updateProjectionMatrix();

  let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspCam;
  let mode: ViewMode = '3d';

  const controls = new OrbitControls<THREE.PerspectiveCamera | THREE.OrthographicCamera>(
    camera, canvas,
  );
  controls.target.set(cx, 0, cz + 1);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.minDistance = 5;
  controls.maxDistance = 48;
  controls.minZoom = 0.35;
  controls.maxZoom = 4;
  controls.maxPolarAngle = Math.PI * 0.44; // 床の下に潜らない(3Dのみ)
  controls.minPolarAngle = 0.05;
  controls.mouseButtons = {
    LEFT: null as unknown as THREE.MOUSE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.ROTATE,
  };
  controls.touches = {
    ONE: null as unknown as THREE.TOUCH,
    TWO: THREE.TOUCH.DOLLY_PAN,
  };
  controls.screenSpacePanning = false;
  controls.update();

  // ---- 照明 ----
  // ベースはIBL。半球光は弱いフィルとして残し、平行光は影の形を作る役
  const hemi = new THREE.HemisphereLight('#ffffff', '#cdd6db', 0.35);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#ffffff', 1.3);
  sun.position.set(cx + 10, 26, cz - 8);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = !lowfx;
  sun.shadow.mapSize.set(2048, 2048);
  const S = 24;
  sun.shadow.camera.left = -S;
  sun.shadow.camera.right = S;
  sun.shadow.camera.top = S;
  sun.shadow.camera.bottom = -S;
  sun.shadow.camera.near = 4;
  sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0006;
  scene.add(sun);
  scene.add(sun.target);

  // FFU天井からの面光源(柔らかいハイライト)。lowfxでは省略
  if (!lowfx) {
    for (const ox of [-MAP_COLS * 0.22, MAP_COLS * 0.22]) {
      const area = new THREE.RectAreaLight('#f4f7ff', 0.85, MAP_COLS * 0.45, MAP_ROWS * 0.8);
      area.position.set(cx + ox, CEIL_Y - 0.05, cz);
      area.lookAt(cx + ox, 0, cz);
      scene.add(area);
    }
  }

  // ---- クリーンルーム建築 ----
  scene.add(buildFloor());
  scene.add(buildRoom());

  // 外周の地面(マップ外)
  const outside = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({ color: '#b9bfc3', roughness: 0.95 }),
  );
  outside.rotation.x = -Math.PI / 2;
  outside.position.set(cx, -0.02, cz);
  outside.receiveShadow = true;
  scene.add(outside);

  // ---- ポストプロセス ----
  // 3D: GTAO + ブルーム + ティルトシフト。2D(真上固定)は精密作業モード
  // なのでトーンマッピングのみ(AO/ブルーム/ボケは作業の邪魔になる)
  let composer: EffectComposer | null = null;
  let tiltH: ShaderPass | null = null;
  let tiltV: ShaderPass | null = null;

  function buildComposer() {
    if (lowfx) return;
    composer?.dispose();
    tiltH = null;
    tiltV = null;
    composer = new EffectComposer(renderer);
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    composer.addPass(new RenderPass(scene, camera));
    if (mode === '3d' && fx === 'high') {
      const gtao = new GTAOPass(scene, camera, window.innerWidth, window.innerHeight);
      composer.addPass(gtao);
    }
    if (mode === '3d') {
      // 閾値はリニアHDR基準。白い床や筐体(輝度~1.5)を拾わず、
      // 積層灯やスクリーン(emissiveIntensity 2以上)だけを光らせる。
      // 2D(真上固定)は明るい機体上面が画面を占めて全体が滲むので外す
      composer.addPass(new UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight), 0.4, 0.4, 1.9,
      ));
    }
    if (mode === '3d' && fx === 'high') {
      tiltH = new ShaderPass(HorizontalTiltShiftShader);
      tiltV = new ShaderPass(VerticalTiltShiftShader);
      composer.addPass(tiltH);
      composer.addPass(tiltV);
      syncTiltShift();
    }
    composer.addPass(new OutputPass());
    composer.setSize(window.innerWidth, window.innerHeight);
  }

  function syncTiltShift() {
    if (!tiltH || !tiltV) return;
    tiltH.uniforms.h.value = TILT_SHIFT_AMOUNT / window.innerWidth;
    tiltV.uniforms.v.value = TILT_SHIFT_AMOUNT / window.innerHeight;
    tiltH.uniforms.r.value = 0.5; // 画面中央に焦点線
    tiltV.uniforms.r.value = 0.5;
  }

  function render() {
    if (composer) composer.render();
    else renderer.render(scene, camera);
    // 銘板・警告はポストプロセス後に上書き描画(深度は見ない)
    renderer.autoClear = false;
    renderer.render(overlay, camera);
    renderer.autoClear = true;
  }

  function setMode(next: ViewMode) {
    if (next === mode) return;
    mode = next;
    camera = mode === '2d' ? orthoCam : perspCam;
    if (mode === '2d') {
      orthoCam.position.set(controls.target.x, ORTHO_HEIGHT, controls.target.z);
      controls.enableRotate = false;
      controls.mouseButtons.RIGHT = null as unknown as THREE.MOUSE;
    } else {
      controls.enableRotate = true;
      controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    }
    controls.object = camera;
    controls.update();
    buildComposer(); // パス構成がモードで違うため作り直す
    resize();
  }

  // ---- リサイズ ----
  const resize = () => {
    const aspect = window.innerWidth / window.innerHeight;
    perspCam.aspect = aspect;
    perspCam.updateProjectionMatrix();
    orthoCam.left = -ORTHO_VIEW_SIZE * aspect;
    orthoCam.right = ORTHO_VIEW_SIZE * aspect;
    orthoCam.top = ORTHO_VIEW_SIZE;
    orthoCam.bottom = -ORTHO_VIEW_SIZE;
    orthoCam.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer?.setSize(window.innerWidth, window.innerHeight);
    syncTiltShift();
  };
  buildComposer();
  resize();

  // ---- ピッキング ----
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hit = new THREE.Vector3();

  const pickTile = (clientX: number, clientY: number) => {
    ndc.set(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    if (!raycaster.ray.intersectPlane(floorPlane, hit)) {
      return { c: -1, r: -1, inside: false };
    }
    const c = Math.floor(hit.x);
    const r = Math.floor(hit.z);
    return {
      c, r,
      inside: c >= 0 && r >= 0 && c < MAP_COLS && r < MAP_ROWS,
    };
  };

  const v3 = new THREE.Vector3();
  const worldToScreen = (x: number, y: number, z: number) => {
    v3.set(x, y, z).project(camera);
    return {
      x: (v3.x * 0.5 + 0.5) * window.innerWidth,
      y: (-v3.y * 0.5 + 0.5) * window.innerHeight,
    };
  };

  return {
    renderer, scene, overlay,
    get camera() { return camera; },
    controls,
    get mode() { return mode; },
    setMode,
    render,
    resize, pickTile, worldToScreen,
  } as SceneCtx;
}

// クリーンルーム床: 艶ありビニルタイル(骨材柄+タイル目地+微細な吸気孔)
function buildFloor(): THREE.Mesh {
  const px = 64; // 1タイルあたりのテクスチャ解像度
  const cv = document.createElement('canvas');
  cv.width = MAP_COLS * px;
  cv.height = MAP_ROWS * px;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#ced2d5';
  g.fillRect(0, 0, cv.width, cv.height);
  // 骨材柄(うっすらした粒)
  for (let i = 0; i < cv.width * cv.height / 90; i++) {
    const v = 198 + Math.random() * 26;
    g.fillStyle = `rgba(${v},${v},${v + 4},0.35)`;
    g.fillRect(Math.random() * cv.width, Math.random() * cv.height, 2, 2);
  }
  for (let tc = 0; tc < MAP_COLS; tc++) {
    for (let tr = 0; tr < MAP_ROWS; tr++) {
      // 吸気孔(パンチングパネルの名残。ごく薄く)
      g.fillStyle = 'rgba(150,158,164,0.35)';
      const n = 4;
      const gap = px / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          g.beginPath();
          g.arc(tc * px + gap / 2 + i * gap, tr * px + gap / 2 + j * gap, 1.4, 0, Math.PI * 2);
          g.fill();
        }
      }
      // タイル目地
      g.strokeStyle = 'rgba(120,126,132,0.5)';
      g.lineWidth = 1.6;
      g.strokeRect(tc * px + 0.8, tr * px + 0.8, px - 1.6, px - 1.6);
    }
  }
  // 外周の縁取り
  g.strokeStyle = '#aab2b8';
  g.lineWidth = 4;
  g.strokeRect(2, 2, cv.width - 4, cv.height - 4);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_COLS, MAP_ROWS),
    new THREE.MeshPhysicalMaterial({
      map: tex, roughness: 0.3, metalness: 0,
      clearcoat: 0.18, clearcoatRoughness: 0.4, envMapIntensity: 0.5,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(MAP_COLS / 2, 0, MAP_ROWS / 2);
  mesh.receiveShadow = true;
  return mesh;
}

// クリーンルームの壁(内向き片面=ドールハウス自動非表示)とFFU天井
function buildRoom(): THREE.Group {
  const group = new THREE.Group();

  // ---- 壁テクスチャ(1パネルぶん: 目地と巾木) ----
  const wcv = document.createElement('canvas');
  wcv.width = 256;
  wcv.height = 512;
  const wg = wcv.getContext('2d')!;
  wg.fillStyle = '#eef0f1';
  wg.fillRect(0, 0, 256, 512);
  // パネル目地(左右端)
  wg.fillStyle = 'rgba(146,154,160,0.7)';
  wg.fillRect(0, 0, 3, 512);
  wg.fillRect(253, 0, 3, 512);
  // 上下の見切り
  wg.fillStyle = 'rgba(170,178,184,0.6)';
  wg.fillRect(0, 0, 256, 4);
  // 巾木(下端の濃い帯)
  wg.fillStyle = '#8f979e';
  wg.fillRect(0, 512 - 34, 256, 34);
  const wallTex = new THREE.CanvasTexture(wcv);
  wallTex.colorSpace = THREE.SRGBColorSpace;
  wallTex.wrapS = THREE.RepeatWrapping;

  const mkWallMat = (repeatX: number) => {
    const t = wallTex.clone();
    t.needsUpdate = true;
    t.repeat.set(repeatX, 1);
    return new THREE.MeshStandardMaterial({
      map: t, roughness: 0.65, side: THREE.FrontSide,
    });
  };

  // 各辺の壁(内側を向く片面ポリゴン。パネル幅は2タイル)
  const mkWall = (
    width: number, x: number, z: number, rotY: number,
  ): THREE.Mesh => {
    const w = new THREE.Mesh(
      new THREE.PlaneGeometry(width, CEIL_Y),
      mkWallMat(width / 2),
    );
    w.position.set(x, CEIL_Y / 2, z);
    w.rotation.y = rotY;
    w.receiveShadow = true;
    return w;
  };
  group.add(mkWall(MAP_COLS, MAP_COLS / 2, 0, 0));                    // 北(内側=+z向き)
  group.add(mkWall(MAP_COLS, MAP_COLS / 2, MAP_ROWS, Math.PI));       // 南
  group.add(mkWall(MAP_ROWS, 0, MAP_ROWS / 2, Math.PI / 2));          // 西
  group.add(mkWall(MAP_ROWS, MAP_COLS, MAP_ROWS / 2, -Math.PI / 2));  // 東

  // ---- FFU天井(下向き片面。2x2タイルのモジュールが市松で発光) ----
  const mod = 128; // 1モジュール(2タイル)あたりのpx
  const ccv = document.createElement('canvas');
  ccv.width = mod * 2;
  ccv.height = mod * 2;
  const ecv = document.createElement('canvas');
  ecv.width = mod * 2;
  ecv.height = mod * 2;
  const cg = ccv.getContext('2d')!;
  const eg = ecv.getContext('2d')!;
  eg.fillStyle = '#000000';
  eg.fillRect(0, 0, mod * 2, mod * 2);
  for (let mx = 0; mx < 2; mx++) {
    for (let mz = 0; mz < 2; mz++) {
      const x = mx * mod;
      const y = mz * mod;
      const lit = (mx + mz) % 2 === 0;
      // フレーム
      cg.fillStyle = '#dbdfe2';
      cg.fillRect(x, y, mod, mod);
      // パネル面
      cg.fillStyle = lit ? '#ffffff' : '#e6e9eb';
      cg.fillRect(x + 7, y + 7, mod - 14, mod - 14);
      if (lit) {
        eg.fillStyle = '#ffffff';
        eg.fillRect(x + 7, y + 7, mod - 14, mod - 14);
      } else {
        // 非発光モジュールはHEPAフィルタのスリット柄
        cg.strokeStyle = 'rgba(158,166,172,0.7)';
        cg.lineWidth = 2;
        for (let i = 1; i < 8; i++) {
          cg.beginPath();
          cg.moveTo(x + 10, y + 7 + i * (mod - 14) / 8);
          cg.lineTo(x + mod - 10, y + 7 + i * (mod - 14) / 8);
          cg.stroke();
        }
      }
    }
  }
  const ceilMap = new THREE.CanvasTexture(ccv);
  ceilMap.colorSpace = THREE.SRGBColorSpace;
  ceilMap.wrapS = ceilMap.wrapT = THREE.RepeatWrapping;
  ceilMap.repeat.set(MAP_COLS / 4, MAP_ROWS / 4);
  const ceilEmis = new THREE.CanvasTexture(ecv);
  ceilEmis.wrapS = ceilEmis.wrapT = THREE.RepeatWrapping;
  ceilEmis.repeat.set(MAP_COLS / 4, MAP_ROWS / 4);

  const ceiling = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_COLS, MAP_ROWS),
    new THREE.MeshStandardMaterial({
      map: ceilMap,
      emissive: '#ffffff', emissiveMap: ceilEmis, emissiveIntensity: 0.9,
      roughness: 0.9, side: THREE.FrontSide,
    }),
  );
  ceiling.rotation.x = Math.PI / 2; // 法線が-y = 下からのみ見える
  ceiling.position.set(MAP_COLS / 2, CEIL_Y, MAP_ROWS / 2);
  group.add(ceiling);

  return group;
}
