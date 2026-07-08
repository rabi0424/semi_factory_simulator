// HTMLオーバーレイのHUD: 上部ステータスストリップ、下部ホットバー、
// 選択装置のコンテキストカード、製品/工程フローパネル。

import {
  MACHINE_DEFS, MAX_FLEET, PRODUCTS, PRODUCT_ORDER, stepsOf,
  FURNACE_BATCH, nodeLabel,
} from './config';
import type { MachineKind, ProductId } from './config';
import { Game } from './sim';
import type { StallInfo } from './sim';
import type { ViewState, Tool } from './view';
import { saveToLocal, clearLocal, exportFile, importFile } from './save';

interface UIOpts {
  root: HTMLElement;
  game: Game;
  vs: ViewState;
  worldToScreen: (x: number, y: number) => { x: number; y: number };
  getMode: () => '2d' | '3d';
  toggleMode: () => void;
}

interface ToolDef {
  key: string;
  name: string;
  tool: Tool;
  drawIcon: (ctx: CanvasRenderingContext2D) => void;
}

const PLACEABLE: MachineKind[] = ['clean', 'depo', 'litho', 'etch', 'furnace', 'inspect'];

export function createUI(opts: UIOpts) {
  const { root, game, vs, worldToScreen, getMode, toggleMode } = opts;

  root.innerHTML = `
    <header id="topbar">
      <div class="brand">半導体工場シミュレーター<span class="tag">PROTO</span></div>
      <div class="stats">
        <span class="stat"><label>仕掛かり</label><b id="stWip">0</b></span>
        <span class="stat"><label>完成</label><b id="stDone">0</b></span>
        <span class="stat"><label>廃棄</label><b id="stScrap">0</b></span>
        <span class="stat"><label>スループット</label><b id="stTp">0.0<i>/分</i></b></span>
        <span class="stat"><label>歩留まり</label><b id="stYield">--</b></span>
        <span class="stat"><label>搬送待ち</label><b id="stWait">--</b></span>
        <span class="stat" id="stBrokenWrap" hidden><label>故障</label><b id="stBroken" style="color:#cc4f44">0</b></span>
        <span class="stat oht">
          <label>OHT</label>
          <button id="ohtMinus" title="保有台数を減らす">−</button>
          <b id="stOht">0</b>
          <button id="ohtPlus" title="OHTを買い足す">+</button>
        </span>
      </div>
      <div class="grow"></div>
      <div class="ctl">
        <span class="spawn"><label>投入間隔</label>
          <input type="range" id="spawnRange" min="2" max="15" step="1" />
          <b id="spawnLabel">6s</b>
        </span>
        <button id="pauseBtn" class="tbtn" title="一時停止/再開">⏸</button>
        <span class="seg" id="speedSeg">
          <button data-speed="1" class="on">1x</button><button data-speed="2">2x</button><button data-speed="4">4x</button>
        </span>
        <button id="modeBtn" class="tbtn" title="2D/3D表示切替 (Shift)">3D表示</button>
        <button id="heatBtn" class="tbtn" title="渋滞ヒートマップ (H)">渋滞</button>
        <button id="flowBtn" class="tbtn on" title="製品/工程パネル (F)">工程</button>
        <span class="menuwrap">
          <button id="dataBtn" class="tbtn" title="セーブ/ロード">データ</button>
          <div id="dataPop" hidden>
            <button id="saveNowBtn">いますぐ保存</button>
            <button id="exportBtn">書き出し (JSON)</button>
            <button id="importBtn">読み込み (JSON)</button>
            <button id="newBtn" class="danger">新規工場</button>
            <p class="dim">10秒ごとに自動保存されます</p>
          </div>
        </span>
      </div>
    </header>
    <aside id="flow">
      <h2>製品ライン</h2>
      <div id="prodTabs"></div>
      <div id="flowSteps"></div>
      <div class="spark">
        <h2>スループット推移 <b id="sparkNow">--</b></h2>
        <canvas id="sparkCv" width="194" height="42"></canvas>
      </div>
    </aside>
    <div id="ctxcard" hidden></div>
    <nav id="hotbar"></nav>
  `;

  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;

  // ---- ホットバー ----
  const toolDefs: ToolDef[] = [
    { key: '1', name: '選択', tool: { mode: 'select', kind: null }, drawIcon: iconSelect },
    { key: '2', name: 'レール', tool: { mode: 'rail', kind: null }, drawIcon: iconRail },
    { key: '3', name: 'レール撤去', tool: { mode: 'railErase', kind: null }, drawIcon: iconRailErase },
    ...PLACEABLE.map((kind, i) => ({
      key: String(4 + i),
      name: MACHINE_DEFS[kind].name.replace('装置', ''),
      tool: { mode: 'place', kind } as Tool,
      drawIcon: (c: CanvasRenderingContext2D) =>
        iconMachine(c, MACHINE_DEFS[kind].accent, MACHINE_DEFS[kind].w),
    })),
    {
      key: '0', name: 'ストッカー',
      tool: { mode: 'place', kind: 'stocker' } as Tool,
      drawIcon: (c: CanvasRenderingContext2D) =>
        iconMachine(c, MACHINE_DEFS.stocker.accent, 2),
    },
    { key: 'X', name: '装置撤去', tool: { mode: 'demolish', kind: null }, drawIcon: iconDemolish },
  ];

  const hotbar = $('#hotbar');
  const toolBtns: HTMLButtonElement[] = [];
  toolDefs.forEach((td) => {
    const btn = document.createElement('button');
    btn.className = 'tool';
    btn.title = `${td.name} [${td.key}]`;
    const cv = document.createElement('canvas');
    cv.width = 40;
    cv.height = 26;
    td.drawIcon(cv.getContext('2d')!);
    const key = document.createElement('i');
    key.textContent = td.key;
    const nm = document.createElement('span');
    nm.textContent = td.name;
    btn.append(key, cv, nm);
    btn.addEventListener('click', () => setTool(td.tool));
    hotbar.appendChild(btn);
    toolBtns.push(btn);
  });

  function setTool(tool: Tool) {
    vs.tool = { ...tool };
    vs.toolRot = 0; // 選択装置を変えたら向きは初期状態(手前=IN/OUT)に戻す
    if (tool.mode !== 'select') vs.selected = null;
    vs.railPath = [];
    syncTool();
  }

  function syncTool() {
    toolDefs.forEach((td, i) => {
      const active = vs.tool.mode === td.tool.mode && vs.tool.kind === td.tool.kind;
      toolBtns[i].classList.toggle('on', active);
    });
  }
  syncTool();

  function selectToolByKey(key: string): boolean {
    const td = toolDefs.find((t) => t.key.toLowerCase() === key.toLowerCase());
    if (!td) return false;
    setTool(td.tool);
    return true;
  }

  // ---- トップバーの操作 ----
  $('#ohtPlus').addEventListener('click', () => {
    game.fleet.size = Math.min(MAX_FLEET, game.fleet.size + 1);
  });
  $('#ohtMinus').addEventListener('click', () => {
    game.fleet.size = Math.max(0, game.fleet.size - 1);
  });

  const spawnRange = $('#spawnRange') as HTMLInputElement;
  const spawnLabel = $('#spawnLabel');
  spawnRange.value = String(game.spawnInterval);
  spawnLabel.textContent = `${game.spawnInterval}s`;
  spawnRange.addEventListener('input', () => {
    game.spawnInterval = Number(spawnRange.value);
    spawnLabel.textContent = `${spawnRange.value}s`;
  });

  const pauseBtn = $('#pauseBtn') as HTMLButtonElement;
  pauseBtn.addEventListener('click', () => {
    game.paused = !game.paused;
    pauseBtn.textContent = game.paused ? '▶' : '⏸';
    pauseBtn.classList.toggle('on', game.paused);
  });

  const speedSeg = $('#speedSeg');
  speedSeg.querySelectorAll('button').forEach((b) =>
    b.addEventListener('click', () => {
      game.speed = Number(b.dataset.speed);
      speedSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    }),
  );

  const flowPanel = $('#flow');
  const flowBtn = $('#flowBtn') as HTMLButtonElement;
  const toggleFlow = () => {
    flowPanel.classList.toggle('hidden');
    flowBtn.classList.toggle('on', !flowPanel.classList.contains('hidden'));
  };
  flowBtn.addEventListener('click', toggleFlow);

  const heatBtn = $('#heatBtn') as HTMLButtonElement;
  const toggleHeat = () => {
    vs.showHeat = !vs.showHeat;
    heatBtn.classList.toggle('on', vs.showHeat);
  };
  heatBtn.addEventListener('click', toggleHeat);

  const modeBtn = $('#modeBtn') as HTMLButtonElement;
  const syncModeBtn = () => {
    modeBtn.textContent = getMode() === '2d' ? '2D表示' : '3D表示';
  };
  modeBtn.addEventListener('click', () => {
    toggleMode();
    syncModeBtn();
  });
  syncModeBtn();

  // ---- データメニュー(セーブ/ロード) ----
  const dataPop = $('#dataPop');
  $('#dataBtn').addEventListener('click', () => {
    dataPop.hidden = !dataPop.hidden;
  });
  document.addEventListener('mousedown', (e) => {
    if (!dataPop.hidden && !(e.target as HTMLElement).closest('.menuwrap')) {
      dataPop.hidden = true;
    }
  });
  const afterLoad = () => {
    vs.selected = null;
    vs.railPath = [];
    dataPop.hidden = true;
  };
  $('#saveNowBtn').addEventListener('click', () => {
    game.onMessage(saveToLocal(game) ? '保存しました' : '保存に失敗しました');
    dataPop.hidden = true;
  });
  $('#exportBtn').addEventListener('click', () => {
    exportFile(game);
    dataPop.hidden = true;
  });
  $('#importBtn').addEventListener('click', () => {
    importFile(game, (ok) => {
      game.onMessage(ok ? '読み込みました' : '読み込みに失敗しました');
      if (ok) afterLoad();
    });
  });
  // window.confirm はサンドボックス化された環境(Artifact埋め込み等)では
  // モーダル表示が抑制され常にfalseを返すため使わず、ボタン自体を2段階の
  // 確認に切り替える(押す→ラベルが変わる→もう一度押すと実行)
  const newBtn = $('#newBtn') as HTMLButtonElement;
  const newBtnLabel = '新規工場';
  const newBtnConfirmLabel = 'もう一度押すと初期化';
  let armed = false;
  let armTimer = 0;
  const disarm = () => {
    armed = false;
    newBtn.textContent = newBtnLabel;
    newBtn.classList.remove('confirming');
  };
  newBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      newBtn.textContent = newBtnConfirmLabel;
      newBtn.classList.add('confirming');
      clearTimeout(armTimer);
      armTimer = window.setTimeout(disarm, 4000);
      return;
    }
    clearTimeout(armTimer);
    disarm();
    game.reset();
    clearLocal();
    game.onMessage('新規工場を開始しました');
    afterLoad();
  });
  // メニューを閉じたら確認状態もリセット
  document.addEventListener('mousedown', (e) => {
    if (armed && !(e.target as HTMLElement).closest('.menuwrap')) disarm();
  });

  // ---- 製品タブ + 工程フロー ----
  const prodTabs = $('#prodTabs');
  const flowSteps = $('#flowSteps');
  let flowProduct: ProductId = 'diode';
  let flowSig = '';
  let stepCnt: HTMLElement[] = [];
  let stepBar: HTMLElement[] = [];

  function rebuildFlow() {
    prodTabs.innerHTML = PRODUCT_ORDER.map((id) => {
      const p = PRODUCTS[id];
      if (!game.unlocked.has(id)) {
        return `<button class="ptab locked" disabled title="累計完成 ${p.unlockAt} ロットで解禁">
          🔒 ${p.name}<small>あと${Math.max(0, p.unlockAt - game.completedCount)}</small></button>`;
      }
      return `<button class="ptab${id === flowProduct ? ' on' : ''}" data-pid="${id}">
        <span class="sw" style="background:${p.color}"></span>${p.name}
        <small>${nodeLabel(game.productGen[id])} ✓${game.completedByProduct[id]}</small></button>`;
    }).join('');
    prodTabs.querySelectorAll<HTMLButtonElement>('.ptab[data-pid]').forEach((b) =>
      b.addEventListener('click', () => {
        flowProduct = b.dataset.pid as ProductId;
        flowSig = '';
      }),
    );

    const gen = game.productGen[flowProduct];
    const steps = stepsOf(flowProduct, gen);
    const otherGen = game.otherGenWipOf(flowProduct, gen);
    flowSteps.innerHTML =
      `<div class="node">プロセスノード <b>${nodeLabel(gen)}</b><small>${steps.length}工程</small></div>` +
      steps
        .map(
          (st, i) => `
        <div class="step">
          <span class="sw" style="background:${MACHINE_DEFS[st.kind].accent}"></span>
          <span class="nm">${i + 1}. ${st.label}</span>
          <span class="bar"><i></i></span>
          <b class="cnt">0</b>
        </div>`,
        )
        .join('') +
      (otherGen > 0
        ? `<div class="othergen">前世代のロットが ${otherGen} 流れています(旧レシピで完了)</div>`
        : '');
    stepCnt = [...flowSteps.querySelectorAll<HTMLElement>('.cnt')];
    stepBar = [...flowSteps.querySelectorAll<HTMLElement>('.bar i')];
  }

  const sparkNow = $('#sparkNow');
  const sparkCv = $('#sparkCv') as HTMLCanvasElement;

  // 直近5分のスループット(単一系列: アクセント色ライン+面、終端を強調)
  function drawSpark(current: number) {
    const c = sparkCv.getContext('2d')!;
    const W = sparkCv.width;
    const H = sparkCv.height;
    c.clearRect(0, 0, W, H);
    const data = [...game.tpHistory.slice(-60), current];
    const max = Math.max(1, ...data);
    const px = (i: number) => (i / Math.max(1, data.length - 1)) * (W - 8) + 2;
    const py = (v: number) => H - 5 - (v / max) * (H - 12);
    c.strokeStyle = '#e2e7ea';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(2, H - 4.5);
    c.lineTo(W - 4, H - 4.5);
    c.stroke();
    c.beginPath();
    data.forEach((v, i) => (i === 0 ? c.moveTo(px(i), py(v)) : c.lineTo(px(i), py(v))));
    c.strokeStyle = '#7761a7';
    c.lineWidth = 2;
    c.lineJoin = 'round';
    c.stroke();
    c.lineTo(px(data.length - 1), H - 5);
    c.lineTo(px(0), H - 5);
    c.closePath();
    c.fillStyle = 'rgba(119, 97, 167, 0.12)';
    c.fill();
    c.beginPath();
    c.arc(px(data.length - 1), py(current), 3, 0, Math.PI * 2);
    c.fillStyle = '#7761a7';
    c.fill();
  }

  // ---- コンテキストカード ----
  const card = $('#ctxcard');
  let cardSig = '';

  function machineStatus(m: Game['machines'][number]): string {
    if (m.broken && m.repairLeft > 0) return `修理中 残り${Math.ceil(m.repairLeft)}s`;
    if (m.broken) return '故障 — 要修理';
    if (m.maintLeft > 0) return `整備中 残り${Math.ceil(m.maintLeft)}s`;
    if (m.busy.length > 0)
      return m.kind === 'furnace' ? `処理中 (${m.busy.length}ロット)` : '処理中';
    if (m.kind === 'furnace' && m.batch.length > 0)
      return `装填中 ${m.batch.length}/${FURNACE_BATCH}`;
    if (m.holdQueue.length > 0) return '出力待ち(ポート満杯)';
    return '待機中';
  }

  function refreshCard() {
    const m = vs.selected;
    if (!m || !game.machines.includes(m)) {
      vs.selected = null;
      card.hidden = true;
      cardSig = '';
      return;
    }
    const def = MACHINE_DEFS[m.kind];
    card.hidden = false;

    // 画面上の装置右肩に追従(引数はタイル単位のワールドXZ)
    const p = worldToScreen(m.col + m.w, m.row);
    card.style.left = `${Math.min(window.innerWidth - 240, Math.max(8, p.x + 8))}px`;
    card.style.top = `${Math.min(window.innerHeight - 260, Math.max(52, p.y))}px`;

    const status = machineStatus(m);
    const portDots = (io: 'in' | 'out') =>
      m.ports.filter((x) => x.io === io).map((x) => (x.foup ? '●' : '○')).join('');
    const weights = PRODUCT_ORDER.map((id) => game.spawnWeights[id]).join(',');
    const stallSig = m.stall ? `${m.stall.reason}:${m.stall.kind}` : '';
    const sig = `${m.id}|${status}|${m.cleanliness.toFixed(2)}|${m.jobs}|${portDots('in')}|${portDots('out')}|${stallSig}|${m.storage.length}|${m.broken}|${weights}|${game.unlocked.size}`;
    if (sig === cardSig) return;
    cardSig = sig;

    card.style.borderTopColor = def.accent;
    card.innerHTML = `
      <div class="head"><span class="nm">${def.name}</span><span class="lbl">${m.label}</span></div>
      <div class="row"><span>状態</span><b>${status}</b></div>
      ${def.placeable && m.kind !== 'stocker'
        ? `<div class="row"><span>清浄度</span>
          <span class="gauge"><i style="width:${m.cleanliness * 100}%;background:${
            m.cleanliness > 0.6 ? '#3f9c5a' : m.cleanliness > 0.35 ? '#d99a2b' : '#cc4f44'
          }"></i></span><b>${(m.cleanliness * 100).toFixed(0)}%</b></div>`
        : ''}
      ${m.kind === 'stocker'
        ? `<div class="row"><span>保管数</span><b>${m.storage.length} / 6</b></div>`
        : def.placeable
          ? `<div class="row"><span>処理数</span><b>${m.jobs}</b></div>`
          : ''}
      <div class="row"><span>ポート</span><b>IN ${portDots('in') || 'ー'}&nbsp; OUT ${portDots('out') || 'ー'}</b></div>
      ${m.stall ? `<div class="alert">${stallMessage(m.stall)}</div>` : ''}
      ${m.broken && m.repairLeft === 0 ? '<div class="alert bad">故障しています。修理を開始してください</div>' : ''}
      ${m.kind === 'load' ? '<div class="mix"><h3>投入比率</h3></div>' : ''}
      <div class="btns"></div>
    `;

    // 投入ステーション: 製品ごとの投入比率エディタ
    if (m.kind === 'load') {
      const mix = card.querySelector('.mix')!;
      for (const id of PRODUCT_ORDER) {
        if (!game.unlocked.has(id)) continue;
        const prod = PRODUCTS[id];
        const row = document.createElement('div');
        row.className = 'mixrow';
        row.innerHTML = `
          <span class="sw" style="background:${prod.color}"></span>
          <span class="nm">${prod.name}</span>
          <button class="mbtn" data-d="-1">−</button>
          <b>${game.spawnWeights[id]}</b>
          <button class="mbtn" data-d="1">+</button>`;
        row.querySelectorAll<HTMLButtonElement>('.mbtn').forEach((b) =>
          b.addEventListener('click', () => {
            const d = Number(b.dataset.d);
            game.spawnWeights[id] = Math.max(0, Math.min(9, game.spawnWeights[id] + d));
          }),
        );
        mix.appendChild(row);
      }
    }

    const btns = card.querySelector('.btns')!;
    if (def.placeable) {
      if (m.broken) {
        const repair = document.createElement('button');
        repair.textContent = `修理 (${Math.ceil(m.repairLeft) || 25}秒)`;
        repair.disabled = m.repairLeft > 0;
        repair.addEventListener('click', () => game.startRepair(m));
        btns.append(repair);
      } else if (m.kind !== 'stocker') {
        const maint = document.createElement('button');
        maint.textContent = 'メンテナンス';
        maint.disabled = m.busy.length > 0 || m.batch.length > 0 || m.maintLeft > 0;
        maint.addEventListener('click', () => game.startMaintenance(m));
        btns.append(maint);
      }
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = '撤去';
      del.addEventListener('click', () => {
        if (game.removeMachine(m)) vs.selected = null;
      });
      btns.append(del);
    } else {
      btns.remove();
    }
  }

  // ---- 定期更新 ----
  function refresh() {
    const st = game.getStats();
    $('#stWip').textContent = String(st.wip);
    $('#stDone').textContent = String(st.completed);
    $('#stScrap').textContent = String(st.scrapped);
    $('#stTp').innerHTML = `${st.throughput.toFixed(1)}<i>/分</i>`;
    $('#stYield').textContent =
      st.completed > 0 ? `${(st.avgYield * 100).toFixed(1)}%` : '--';
    $('#stWait').textContent =
      st.avgWait > 0 ? `${st.avgWait.toFixed(1)}s` : '--';
    ($('#stBrokenWrap') as HTMLElement).hidden = st.broken === 0;
    $('#stBroken').textContent = String(st.broken);
    $('#stOht').textContent = `${st.ohtTotal}/${st.ohtSize}台`;
    ($('#stOht') as HTMLElement).title =
      `稼働 ${st.ohtTotal - st.ohtIdle} / 待機 ${st.ohtIdle} / 保有枠 ${st.ohtSize}`;

    if (!flowPanel.classList.contains('hidden')) {
      // タブ構成・世代・前世代残存数が変わったときだけDOMを作り直す
      const gen = game.productGen[flowProduct];
      const sig =
        `${flowProduct}|${gen}|${game.otherGenWipOf(flowProduct, gen)}|` +
        `${[...game.unlocked].join(',')}|` +
        PRODUCT_ORDER.map((id) => game.completedByProduct[id]).join(',');
      if (sig !== flowSig) {
        flowSig = sig;
        rebuildFlow();
      }
      const wip = game.stepWipOf(flowProduct, gen);
      const maxWip = Math.max(1, ...wip);
      wip.forEach((n, i) => {
        if (stepCnt[i]) {
          stepCnt[i].textContent = String(n);
          stepBar[i].style.width = `${(n / maxWip) * 100}%`;
        }
      });
      sparkNow.textContent = `${st.throughput.toFixed(1)}/分`;
      drawSpark(st.throughput);
    }

    syncModeBtn(); // Shiftキーでの切替もここで反映
    refreshCard();
  }

  return { refresh, syncTool, selectToolByKey, toggleFlow, toggleHeat, setTool };
}

// 出力FOUPの滞留理由を、プレイヤー向けの一文にする
function stallMessage(st: StallInfo): string {
  const name = MACHINE_DEFS[st.kind].name;
  if (st.reason === 'missing') return `次工程の装置「${name}」が未設置です`;
  if (st.reason === 'down') return `次工程の装置「${name}」が全て停止中です`;
  return `${name}へのレール経路がありません`;
}

// ---- ホットバーのアイコン(Canvas描画) ----

function iconSelect(c: CanvasRenderingContext2D) {
  c.fillStyle = '#37444c';
  c.beginPath();
  c.moveTo(14, 4);
  c.lineTo(14, 20);
  c.lineTo(18.5, 15.5);
  c.lineTo(22, 22);
  c.lineTo(24.5, 20.5);
  c.lineTo(21, 14.5);
  c.lineTo(26, 13.5);
  c.closePath();
  c.fill();
}

function iconRail(c: CanvasRenderingContext2D) {
  c.strokeStyle = '#aab4bb';
  c.lineWidth = 6;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(6, 13);
  c.lineTo(34, 13);
  c.stroke();
  c.strokeStyle = '#f0f3f4';
  c.lineWidth = 2.5;
  c.beginPath();
  c.moveTo(6, 13);
  c.lineTo(34, 13);
  c.stroke();
  c.strokeStyle = '#66727c';
  c.lineWidth = 1.6;
  c.beginPath();
  c.moveTo(17, 9);
  c.lineTo(21, 13);
  c.lineTo(17, 17);
  c.stroke();
}

function iconRailErase(c: CanvasRenderingContext2D) {
  iconRail(c);
  c.strokeStyle = '#cc4f44';
  c.lineWidth = 2.5;
  c.beginPath();
  c.moveTo(10, 22);
  c.lineTo(30, 4);
  c.stroke();
}

function iconMachine(c: CanvasRenderingContext2D, accent: string, w: number) {
  const bw = w >= 3 ? 30 : 24;
  const x = (40 - bw) / 2;
  c.fillStyle = '#fbfcfd';
  c.strokeStyle = '#b9c3c9';
  c.lineWidth = 1;
  c.fillRect(x, 5, bw, 15);
  c.strokeRect(x + 0.5, 5.5, bw - 1, 14);
  c.fillStyle = accent;
  c.fillRect(x + 1, 16, bw - 2, 3);
  c.fillStyle = '#d5dbdf';
  c.fillRect(x, 20, bw, 3);
}

function iconDemolish(c: CanvasRenderingContext2D) {
  iconMachine(c, '#c3ccd2', 2);
  c.strokeStyle = '#cc4f44';
  c.lineWidth = 2.5;
  c.beginPath();
  c.moveTo(11, 22);
  c.lineTo(29, 4);
  c.moveTo(29, 22);
  c.lineTo(11, 4);
  c.stroke();
}
