// Three.js シーン基盤: レンダラー・軌道カメラ・照明・クリーンルーム床・
// タイルピッキング。ワールド座標の単位は「1タイル = 1」(x=列, z=行, y=上)。
//
// カメラは透視(3D)と直交・真上固定(2D)の2つを切り替えて使う。同じ
// OrbitControls インスタンスの .object を差し替える方式で、パン位置や
// ズームはカメラごとに保持されるため、モード切替のたびに元の見た目に戻る。

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MAP_COLS, MAP_ROWS } from '../config';

export type ViewMode = '2d' | '3d';

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera; // 現在アクティブなカメラ
  controls: OrbitControls;
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
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

export function createScene(canvas: HTMLCanvasElement): SceneCtx {
  // ?lowfx で影とAAを切る軽量モード(非力な環境・E2Eテスト用)
  const lowfx = new URLSearchParams(location.search).has('lowfx');
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !lowfx,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(lowfx ? 1 : Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = !lowfx;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#dfe4e7');
  scene.fog = new THREE.Fog('#dfe4e7', 55, 120);

  const cx = MAP_COLS / 2;
  const cz = MAP_ROWS / 2;

  // ---- 3Dカメラ(透視) ----
  const perspCam = new THREE.PerspectiveCamera(
    40, window.innerWidth / window.innerHeight, 0.1, 300,
  );
  perspCam.position.set(cx, 25, cz + 15.5);

  // ---- 2Dカメラ(直交・真上固定)----
  // 装置の真上にレールを正確に敷けるよう、パースによる見た目のズレを
  // なくすため常に真上から見下ろす。回転は無効、パン/ズームのみ
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
  // 左ボタンはツール操作に使うため、カメラ操作は中=パン、右=回転(3Dのみ)。
  // 右クリックは装置設置時の回転(main.ts側でクリック判定)にも使うため、
  // 2Dモードでは右ボタンをカメラ操作から完全に外す
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

  function setMode(next: ViewMode) {
    if (next === mode) return;
    mode = next;
    camera = mode === '2d' ? orthoCam : perspCam;
    if (mode === '2d') {
      // 直交カメラは常にターゲット直上(真上固定)。パンで動いた
      // ターゲットのXZに合わせて位置を揃える
      orthoCam.position.set(controls.target.x, ORTHO_HEIGHT, controls.target.z);
      controls.enableRotate = false;
      controls.mouseButtons.RIGHT = null as unknown as THREE.MOUSE;
    } else {
      controls.enableRotate = true;
      controls.mouseButtons.RIGHT = THREE.MOUSE.ROTATE;
    }
    controls.object = camera;
    controls.update();
    resize();
  }

  // ---- 照明 ----
  const hemi = new THREE.HemisphereLight('#ffffff', '#cdd6db', 1.35);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#ffffff', 2.1);
  sun.position.set(cx + 10, 26, cz - 8);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const S = 22;
  sun.shadow.camera.left = -S;
  sun.shadow.camera.right = S;
  sun.shadow.camera.top = S;
  sun.shadow.camera.bottom = -S;
  sun.shadow.camera.near = 4;
  sun.shadow.camera.far = 60;
  sun.shadow.bias = -0.0006;
  scene.add(sun);
  scene.add(sun.target);

  // ---- 床 ----
  scene.add(buildFloor());

  // 外周の地面(マップ外)
  const outside = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240),
    new THREE.MeshStandardMaterial({ color: '#d3d9dd', roughness: 0.95 }),
  );
  outside.rotation.x = -Math.PI / 2;
  outside.position.set(cx, -0.02, cz);
  outside.receiveShadow = true;
  scene.add(outside);

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
  };
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
    renderer, scene,
    get camera() { return camera; },
    controls,
    get mode() { return mode; },
    setMode,
    resize, pickTile, worldToScreen,
  } as SceneCtx;
}

// クリーンルーム床: パンチングパネル模様のテクスチャを1枚のキャンバスに生成
function buildFloor(): THREE.Mesh {
  const px = 48; // 1タイルあたりのテクスチャ解像度
  const cv = document.createElement('canvas');
  cv.width = MAP_COLS * px;
  cv.height = MAP_ROWS * px;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#f2f4f6';
  g.fillRect(0, 0, cv.width, cv.height);
  g.fillStyle = '#e0e6e9';
  const n = 4;
  const gap = px / n;
  for (let tc = 0; tc < MAP_COLS; tc++) {
    for (let tr = 0; tr < MAP_ROWS; tr++) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          g.beginPath();
          g.arc(
            tc * px + gap / 2 + i * gap,
            tr * px + gap / 2 + j * gap,
            1.7, 0, Math.PI * 2,
          );
          g.fill();
        }
      }
      g.strokeStyle = '#e8edef';
      g.lineWidth = 1;
      g.strokeRect(tc * px + 0.5, tr * px + 0.5, px - 1, px - 1);
    }
  }
  // 外周の縁取り
  g.strokeStyle = '#c8d1d6';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, cv.width - 3, cv.height - 3);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(MAP_COLS, MAP_ROWS),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9, metalness: 0 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(MAP_COLS / 2, 0, MAP_ROWS / 2);
  mesh.receiveShadow = true;
  return mesh;
}
