// HTMLオーバーレイのHUD: 上部ステータスストリップ、下部カテゴリ式建設メニュー、
// 技術ツリーパネル、選択装置のコンテキストカード(ライン設定含む)、
// 製品/工程フローパネル(市場鮮度・損益・省略レシピ)。

import {
  MACHINE_DEFS, PRODUCTS, PRODUCT_ORDER, stepsOf, compactSteps,
  FURNACE_BATCH, nodeLabel, NODE_DEFS,
  LITHO_KINDS, minLithoTier, lithoPasses,
  OHT_COST, RAIL_COST, SELL_RATIO,
} from './config';
import type { MachineKind, ProductId, BuildCategory } from './config';
import { Game } from './sim';
import type { StallInfo, Machine } from './sim';
import type { ViewState, Tool } from './view';
import { saveToLocal, clearLocal, exportFile, importFile } from './save';
import { sound } from './sound';

interface UIOpts {
  root: HTMLElement;
  game: Game;
  vs: ViewState;
  worldToScreen: (x: number, y: number) => { x: number; y: number };
  getMode: () => '2d' | '3d';
  toggleMode: () => void;
}

// 建設メニューのカテゴリ構成
const CATEGORIES: { key: BuildCategory; label: string; kinds: MachineKind[] }[] = [
  { key: 'station', label: 'ステーション', kinds: ['load', 'ship'] },
  { key: 'litho', label: '露光', kinds: ['litho', 'krf', 'arf', 'euv', 'euvhna'] },
  { key: 'thermal', label: '熱処理', kinds: ['furnace', 'implant', 'ald'] },
  { key: 'depoetch', label: '成膜/エッチ', kinds: ['clean', 'depo', 'etch'] },
  { key: 'beol', label: 'BEOL配線', kinds: ['metal', 'cu', 'cmp'] },
  { key: 'logistics', label: '検査/物流', kinds: ['inspect', 'stocker'] },
];

export function createUI(opts: UIOpts) {
  const { root, game, vs, worldToScreen, getMode, toggleMode } = opts;

  root.innerHTML = `
    <header id="topbar">
      <div class="brand">半導体工場シミュレーター<span class="tag">PROTO</span></div>
      <div class="stats">
        <span class="stat money"><label>資金</label><b id="stMoney">--</b></span>
        <span class="stat"><label>仕掛かり</label><b id="stWip">0</b></span>
        <span class="stat"><label>完成</label><b id="stDone">0</b></span>
        <span class="stat"><label>廃棄</label><b id="stScrap">0</b></span>
        <span class="stat"><label>スループット</label><b id="stTp">0.0<i>/分</i></b></span>
        <span class="stat" title="直近30ロットの移動平均"><label>歩留まり</label><b id="stYield">--</b></span>
        <span class="stat"><label>搬送待ち</label><b id="stWait">--</b></span>
        <span class="stat" id="stPmWrap" hidden><label>整備中</label><b id="stPm" style="color:#b07f19">0</b></span>
        <span class="stat oht">
          <label>OHT</label>
          <button id="ohtMinus" title="売却 (+¥${(OHT_COST * SELL_RATIO).toLocaleString()})">−</button>
          <b id="stOht">0</b>
          <button id="ohtPlus" title="OHTを買い足す (¥${OHT_COST.toLocaleString()})">+</button>
        </span>
      </div>
      <div class="grow"></div>
      <div class="ctl">
        <span class="spawn" title="新しい投入ステーションの既定投入間隔"><label>既定投入</label>
          <input type="range" id="spawnRange" min="2" max="15" step="1" />
          <b id="spawnLabel">6s</b>
        </span>
        <button id="pauseBtn" class="tbtn" title="一時停止/再開">⏸</button>
        <span class="seg" id="speedSeg">
          <button data-speed="1" class="on">1x</button><button data-speed="2">2x</button><button data-speed="4">4x</button>
        </span>
        <button id="techBtn" class="tbtn" title="技術ツリー(研究)">研究</button>
        <button id="modeBtn" class="tbtn" title="2D/3D表示切替 (Shift)">3D表示</button>
        <button id="heatBtn" class="tbtn" title="渋滞ヒートマップ (H)">渋滞</button>
        <button id="flowBtn" class="tbtn on" title="製品/工程パネル (F)">工程</button>
        <button id="muteBtn" class="tbtn" title="効果音のオン/オフ">♪</button>
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
    <aside id="tech" class="hidden"></aside>
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

  root.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('button')) sound.click();
  });

  // 効果音のオン/オフ
  const muteBtn = $('#muteBtn') as HTMLButtonElement;
  const syncMute = () => {
    muteBtn.textContent = sound.muted ? '🔇' : '♪';
    muteBtn.classList.toggle('on', !sound.muted);
  };
  muteBtn.addEventListener('click', () => {
    sound.setMuted(!sound.muted);
    syncMute();
  });
  syncMute();

  // ---- 建設メニュー(カテゴリタブ + 装置)----
  const fixedTools: { key: string; name: string; tool: Tool; drawIcon: (c: CanvasRenderingContext2D) => void; cost?: number }[] = [
    { key: '1', name: '選択', tool: { mode: 'select', kind: null }, drawIcon: iconSelect },
    { key: '2', name: 'レール', cost: RAIL_COST, tool: { mode: 'rail', kind: null }, drawIcon: iconRail },
    { key: '3', name: 'レール撤去', tool: { mode: 'railErase', kind: null }, drawIcon: iconRailErase },
    { key: 'X', name: '装置撤去', tool: { mode: 'demolish', kind: null }, drawIcon: iconDemolish },
  ];

  let activeCat: BuildCategory = 'station';
  const hotbar = $('#hotbar');
  const allToolBtns: { btn: HTMLButtonElement; tool: Tool }[] = [];

  function buildHotbar() {
    hotbar.innerHTML = '';
    allToolBtns.length = 0;

    // カテゴリタブ
    const catbar = document.createElement('div');
    catbar.className = 'catbar';
    CATEGORIES.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'cat' + (c.key === activeCat ? ' on' : '');
      b.textContent = c.label;
      b.addEventListener('click', () => { activeCat = c.key; buildHotbar(); });
      catbar.appendChild(b);
    });
    hotbar.appendChild(catbar);

    // ツール行: 固定ツール | セパレータ | カテゴリの装置
    const row = document.createElement('div');
    row.className = 'toolrow';
    const addTool = (
      key: string, name: string, tool: Tool,
      drawIcon: (c: CanvasRenderingContext2D) => void, cost?: number,
    ) => {
      const btn = document.createElement('button');
      btn.className = 'tool';
      btn.title = `${name}${key ? ` [${key}]` : ''}` +
        (cost ? ` — ¥${cost.toLocaleString()}${tool.mode === 'rail' ? '/区間' : ''}` : '');
      const cv = document.createElement('canvas');
      cv.width = 40; cv.height = 26;
      drawIcon(cv.getContext('2d')!);
      const nm = document.createElement('span');
      nm.textContent = name;
      if (key) {
        const k = document.createElement('i');
        k.textContent = key;
        btn.append(k);
      }
      btn.append(cv, nm);
      if (cost) {
        const em = document.createElement('em');
        em.textContent = `¥${cost.toLocaleString()}${tool.mode === 'rail' ? '/区間' : ''}`;
        btn.append(em);
      }
      btn.addEventListener('click', () => setTool(tool));
      row.appendChild(btn);
      allToolBtns.push({ btn, tool });
    };

    for (const t of fixedTools) addTool(t.key, t.name, t.tool, t.drawIcon, t.cost);
    const sep = document.createElement('div');
    sep.className = 'sep';
    row.appendChild(sep);

    const cat = CATEGORIES.find((c) => c.key === activeCat)!;
    for (const kind of cat.kinds) {
      const def = MACHINE_DEFS[kind];
      addTool(
        '', def.name.replace('装置', ''),
        { mode: 'place', kind },
        (c) => iconMachine(c, def.accent, def.w),
        def.cost,
      );
    }
    hotbar.appendChild(row);
    syncTool();
  }

  function setTool(tool: Tool) {
    vs.tool = { ...tool };
    vs.toolRot = 0;
    if (tool.mode !== 'select') vs.selected = null;
    vs.railPath = [];
    // 選択した装置のカテゴリへタブを合わせる
    if (tool.mode === 'place' && tool.kind) {
      const c = CATEGORIES.find((cc) => cc.kinds.includes(tool.kind!));
      if (c && c.key !== activeCat) { activeCat = c.key; buildHotbar(); return; }
    }
    syncTool();
  }

  function syncTool() {
    for (const { btn, tool } of allToolBtns) {
      btn.classList.toggle('on', vs.tool.mode === tool.mode && vs.tool.kind === tool.kind);
    }
  }

  function selectToolByKey(key: string): boolean {
    const t = fixedTools.find((x) => x.key.toLowerCase() === key.toLowerCase());
    if (!t) return false;
    setTool(t.tool);
    return true;
  }

  buildHotbar();

  // ---- トップバーの操作 ----
  $('#ohtPlus').addEventListener('click', () => game.buyVehicle());
  $('#ohtMinus').addEventListener('click', () => game.sellVehicle());

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

  // ---- 技術ツリーパネル ----
  const techPanel = $('#tech');
  const techBtn = $('#techBtn') as HTMLButtonElement;
  let techSig = '';
  const toggleTech = () => {
    techPanel.classList.toggle('hidden');
    techBtn.classList.toggle('on', !techPanel.classList.contains('hidden'));
    if (!techPanel.classList.contains('hidden')) { techSig = ''; renderTech(); }
  };
  techBtn.addEventListener('click', toggleTech);

  function renderTech() {
    const r = game.research;
    const activeHtml = r
      ? `<div class="active">
          <div class="lbl">研究中: ${r.type === 'node' ? nodeLabel(r.node) + ' プロセス' : PRODUCTS[r.product].name}</div>
          <div class="pbar"><i style="width:${(1 - r.timeLeft / r.total) * 100}%"></i></div>
          <button class="cancel" id="cancelResearch">中止(半額返金)</button>
        </div>`
      : '';

    const nodesHtml = NODE_DEFS.map((nd) => {
      if (game.nodesUnlocked.has(nd.gen)) {
        return `<div class="titem done">${nd.label}<small>✓ 解禁済</small></div>`;
      }
      const avail = game.canResearchNode(nd.gen) && !r && game.money >= nd.research;
      const cls = game.canResearchNode(nd.gen) ? (avail ? 'avail' : '') : 'locked';
      return `<button class="titem ${cls}" data-node="${nd.gen}" ${avail ? '' : 'disabled'}>
        ${nd.label}<small>¥${(nd.research / 1000).toFixed(0)}k / ${nd.researchTime}s</small></button>`;
    }).join('');

    const prodHtml = PRODUCT_ORDER.map((id) => {
      const p = PRODUCTS[id];
      if (game.productsUnlocked.has(id)) {
        return `<div class="titem done prod"><div class="nm"><span class="sw" style="background:${p.color}"></span>${p.name}</div><small>✓ 開発済</small></div>`;
      }
      if (p.research <= 0) return '';
      const avail = game.canResearchProduct(id) && !r && game.money >= p.research;
      const canR = game.canResearchProduct(id);
      const req: string[] = [];
      for (const rq of p.requires) if (!game.productsUnlocked.has(rq)) req.push(PRODUCTS[rq].name);
      if (!game.nodesUnlocked.has(p.reqNode)) req.push(`${nodeLabel(p.reqNode)}ノード`);
      const reqTxt = req.length ? `要: ${req.join('・')}` : `¥${(p.research / 1000).toFixed(0)}k`;
      const cls = canR ? (avail ? 'avail' : '') : 'locked';
      return `<button class="titem ${cls} prod" data-prod="${id}" ${avail ? '' : 'disabled'}>
        <div class="nm"><span class="sw" style="background:${p.color}"></span>${p.name}</div>
        <small>${reqTxt}</small></button>`;
    }).join('');

    techPanel.innerHTML =
      `<h2>技術ツリー</h2>${activeHtml}` +
      `<h2>プロセスノード</h2><div class="nodes">${nodesHtml}</div>` +
      `<h2>製品開発</h2><div class="nodes">${prodHtml}</div>`;

    techPanel.querySelector('#cancelResearch')?.addEventListener('click', () => {
      game.cancelResearch(); techSig = ''; renderTech();
    });
    techPanel.querySelectorAll<HTMLButtonElement>('[data-node]').forEach((b) =>
      b.addEventListener('click', () => {
        if (game.startNodeResearch(Number(b.dataset.node))) { techSig = ''; renderTech(); }
      }),
    );
    techPanel.querySelectorAll<HTMLButtonElement>('[data-prod]').forEach((b) =>
      b.addEventListener('click', () => {
        if (game.startProductResearch(b.dataset.prod as ProductId)) { techSig = ''; renderTech(); }
      }),
    );
  }

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
  modeBtn.addEventListener('click', () => { toggleMode(); syncModeBtn(); });
  syncModeBtn();

  // ---- データメニュー ----
  const dataPop = $('#dataPop');
  $('#dataBtn').addEventListener('click', () => { dataPop.hidden = !dataPop.hidden; });
  document.addEventListener('mousedown', (e) => {
    if (!dataPop.hidden && !(e.target as HTMLElement).closest('.menuwrap')) dataPop.hidden = true;
  });
  const afterLoad = () => {
    vs.selected = null;
    vs.railPath = [];
    dataPop.hidden = true;
    techSig = '';
    buildHotbar();
  };
  $('#saveNowBtn').addEventListener('click', () => {
    game.onMessage(saveToLocal(game) ? '保存しました' : '保存に失敗しました');
    dataPop.hidden = true;
  });
  $('#exportBtn').addEventListener('click', () => { exportFile(game); dataPop.hidden = true; });
  $('#importBtn').addEventListener('click', () => {
    importFile(game, (ok) => {
      game.onMessage(ok ? '読み込みました' : '読み込みに失敗しました');
      if (ok) afterLoad();
    });
  });
  const newBtn = $('#newBtn') as HTMLButtonElement;
  let armed = false;
  let armTimer = 0;
  const disarm = () => { armed = false; newBtn.textContent = '新規工場'; newBtn.classList.remove('confirming'); };
  newBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      newBtn.textContent = 'もう一度押すと初期化';
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
  document.addEventListener('mousedown', (e) => {
    if (armed && !(e.target as HTMLElement).closest('.menuwrap')) disarm();
  });

  // ---- 製品タブ + 工程フロー ----
  const prodTabs = $('#prodTabs');
  const flowSteps = $('#flowSteps');
  let flowProduct: ProductId = 'diode';
  let flowGen = 0;
  let flowSig = '';
  let stepCnt: HTMLElement[] = [];
  let stepBar: HTMLElement[] = [];
  let stepUtil: HTMLElement[] = [];
  let stepRows: HTMLElement[] = [];
  let compactMap: { kind: MachineKind; from: number; count: number }[] = [];

  function rebuildFlow() {
    prodTabs.innerHTML = PRODUCT_ORDER.map((id) => {
      const p = PRODUCTS[id];
      if (!game.productsUnlocked.has(id)) {
        return `<button class="ptab locked" disabled title="技術ツリーで研究して解禁">🔒 ${p.name}</button>`;
      }
      return `<button class="ptab${id === flowProduct ? ' on' : ''}" data-pid="${id}">
        <span class="sw" style="background:${p.color}"></span>${p.name}
        <small>✓${game.completedByProduct[id]}</small></button>`;
    }).join('');
    prodTabs.querySelectorAll<HTMLButtonElement>('.ptab[data-pid]').forEach((b) =>
      b.addEventListener('click', () => { flowProduct = b.dataset.pid as ProductId; flowSig = ''; }),
    );

    // 表示ノードは研究済みの中から選択(範囲外なら最寄りへ丸める)
    const unlockedGens = NODE_DEFS.filter((n) => game.nodesUnlocked.has(n.gen)).map((n) => n.gen);
    if (!unlockedGens.includes(flowGen)) flowGen = unlockedGens[unlockedGens.length - 1] ?? 0;
    const expo = game.resolveExpoTier(flowGen, -1);
    const steps = stepsOf(flowProduct, flowGen, expo);
    const compact = compactSteps(steps);
    const est = game.estimateProfit(flowProduct, flowGen);
    const otherGen = game.otherGenWipOf(flowProduct, flowGen);

    const nodeOpts = unlockedGens
      .map((g) => `<option value="${g}"${g === flowGen ? ' selected' : ''}>${nodeLabel(g)}</option>`)
      .join('');

    flowSteps.innerHTML =
      `<div class="nodesel"><span>ノード</span><select id="flowNode">${nodeOpts}</select>
        <small style="color:var(--dim)">${steps.length}工程</small></div>` +
      `<div class="market">市場鮮度
        <span class="freshbar"><i style="width:${est.fresh * 100}%"></i></span>
        ${(est.fresh * 100).toFixed(0)}% ・ 粗利 ¥${Math.round(est.profit).toLocaleString()}/ロット</div>` +
      compact
        .map((cs, i) => {
          const rep = cs.repeat > 1
            ? (cs.block
                ? `<span class="rep">${cs.block.map((b) => MACHINE_DEFS[b.kind].short).join('→')} ×${cs.repeat}</span>`
                : `<span class="rep">×${cs.count}</span>`)
            : '';
          const label = cs.block
            ? `${cs.block[0].label.replace(/\s*\d+\/\d+$|①|②|③/g, '').trim() || 'ブロック'}`
            : cs.step.label;
          return `<div class="step" data-idx="${i}" title="クリックでフロア上の${MACHINE_DEFS[cs.step.kind].name}をハイライト">
            <span class="sw" style="background:${MACHINE_DEFS[cs.step.kind].accent}"></span>
            <span class="nm">${label}</span>
            ${rep}
            <b class="util">--</b>
            <span class="bar"><i></i></span>
            <b class="cnt">0</b>
          </div>`;
        })
        .join('') +
      `<div class="legend">稼働率 / 仕掛かり — 繰り返しは ×N で省略表示</div>` +
      (otherGen > 0
        ? `<div class="othergen">別ノードのロットが ${otherGen} 流れています</div>`
        : '');

    stepCnt = [...flowSteps.querySelectorAll<HTMLElement>('.cnt')];
    stepBar = [...flowSteps.querySelectorAll<HTMLElement>('.bar i')];
    stepUtil = [...flowSteps.querySelectorAll<HTMLElement>('.util')];
    stepRows = [...flowSteps.querySelectorAll<HTMLElement>('.step')];
    compactMap = compact.map((cs) => ({ kind: cs.step.kind, from: cs.from, count: cs.count }));

    flowSteps.querySelector<HTMLSelectElement>('#flowNode')?.addEventListener('change', (e) => {
      flowGen = Number((e.target as HTMLSelectElement).value);
      flowSig = '';
    });
    stepRows.forEach((row, i) => {
      row.addEventListener('click', () => {
        const kind = compactMap[i].kind;
        vs.highlightKind = vs.highlightKind === kind ? null : kind;
      });
    });
  }

  const sparkNow = $('#sparkNow');
  const sparkCv = $('#sparkCv') as HTMLCanvasElement;

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

  function machineStatus(m: Machine): string {
    if (m.pm) return `整備中 残り${Math.ceil(m.pmLeft)}s`;
    if (m.busy.length > 0) return m.kind === 'furnace' ? `処理中 (${m.busy.length}ロット)` : '処理中';
    if (m.kind === 'furnace' && m.batch.length > 0) return `装填中 ${m.batch.length}/${FURNACE_BATCH}`;
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

    const p = worldToScreen(m.col + m.w, m.row);
    card.style.left = `${Math.min(window.innerWidth - 244, Math.max(8, p.x + 8))}px`;
    card.style.top = `${Math.min(window.innerHeight - 320, Math.max(52, p.y))}px`;

    const status = machineStatus(m);
    const portDots = (io: 'in' | 'out') =>
      m.ports.filter((x) => x.io === io).map((x) => (x.foup ? '●' : '○')).join('');
    const stallSig = m.stall ? `${m.stall.reason}:${m.stall.kind}` : '';
    const purgeable =
      m.ports.filter((p) => p.foup && !p.reserved).length +
      m.holdQueue.length + m.batch.length + m.storage.length;
    const lineSig = m.line ? `${m.line.product}|${m.line.gen}|${m.line.expo}|${m.line.interval}` : '';
    const sig = `${m.id}|${status}|${m.cleanliness.toFixed(2)}|${Math.round(m.util * 20)}|${m.jobs}|${portDots('in')}|${portDots('out')}|${stallSig}|${m.storage.length}|${m.pm}|${purgeable}|${lineSig}|${game.productsUnlocked.size}|${game.nodesUnlocked.size}`;
    if (sig === cardSig) return;
    cardSig = sig;

    card.style.borderTopColor = def.accent;
    card.innerHTML = `
      <div class="head"><span class="nm">${def.name}</span><span class="lbl">${m.label}</span></div>
      <div class="row"><span>状態</span><b>${status}</b></div>
      ${def.placeable && m.kind !== 'stocker' && m.kind !== 'load' && m.kind !== 'ship'
        ? `<div class="row"><span>清浄度</span>
          <span class="gauge"><i style="width:${m.cleanliness * 100}%;background:${
            m.cleanliness > 0.6 ? '#3f9c5a' : m.cleanliness > 0.35 ? '#d99a2b' : '#cc4f44'
          }"></i></span><b>${(m.cleanliness * 100).toFixed(0)}%</b></div>
          <div class="row"><span>稼働率</span>
          <span class="gauge"><i style="width:${m.util * 100}%;background:${
            m.util >= 0.85 ? '#cc4f44' : m.util >= 0.6 ? '#d99a2b' : '#7761a7'
          }"></i></span><b>${(m.util * 100).toFixed(0)}%</b></div>
          <div class="row"><span>処理数</span><b>${m.jobs}</b></div>`
        : ''}
      ${m.kind === 'stocker' ? `<div class="row"><span>保管数</span><b>${m.storage.length} / 6</b></div>` : ''}
      <div class="row"><span>ポート</span><b>IN ${portDots('in') || 'ー'}&nbsp; OUT ${portDots('out') || 'ー'}</b></div>
      ${m.stall ? `<div class="alert">${stallMessage(m.stall)}</div>` : ''}
      ${m.kind === 'load' ? '<div class="cfg"><h3>生産ライン設定</h3></div>' : ''}
      <div class="btns"></div>
    `;

    if (m.kind === 'load' && m.line) buildLineConfig(card.querySelector('.cfg')!, m);

    const btns = card.querySelector('.btns')!;
    if (purgeable > 0) {
      const purge = document.createElement('button');
      purge.className = 'danger';
      purge.textContent = `滞留ロット廃棄 (${purgeable})`;
      purge.addEventListener('click', () => {
        const n = game.purgeMachine(m);
        if (n > 0) game.onMessage(`${m.label} の滞留ロット ${n} 件を廃棄しました`);
      });
      btns.append(purge);
    }
    if (def.placeable) {
      const del = document.createElement('button');
      del.className = 'danger';
      del.textContent = `撤去 (+¥${(def.cost * SELL_RATIO).toLocaleString()})`;
      del.addEventListener('click', () => { if (game.removeMachine(m)) vs.selected = null; });
      btns.append(del);
    }
    if (btns.childElementCount === 0) btns.remove();
  }

  // 投入ステーションの生産ライン設定エディタ
  function buildLineConfig(host: Element, m: Machine) {
    const line = m.line!;
    const prods = PRODUCT_ORDER.filter((id) => game.productsUnlocked.has(id));
    if (!prods.includes(line.product)) line.product = prods[0] ?? 'diode';
    // 製品の最低ノード要件でノード候補を絞る
    const reqNode = PRODUCTS[line.product].reqNode;
    const gens = NODE_DEFS.filter((n) => game.nodesUnlocked.has(n.gen) && n.gen >= reqNode).map((n) => n.gen);
    if (!gens.includes(line.gen)) line.gen = gens[0] ?? reqNode;
    const minT = minLithoTier(line.gen);

    const prodOpts = prods
      .map((id) => `<option value="${id}"${id === line.product ? ' selected' : ''}>${PRODUCTS[id].name}</option>`)
      .join('');
    const nodeOpts = gens
      .map((g) => `<option value="${g}"${g === line.gen ? ' selected' : ''}>${nodeLabel(g)}</option>`)
      .join('');
    const expoOpts = [`<option value="-1"${line.expo < 0 ? ' selected' : ''}>自動</option>`]
      .concat(LITHO_KINDS.map((k, t) => {
        if (t < minT) return '';
        const owned = game.machines.some((x) => x.kind === k);
        const pass = lithoPasses(t, line.gen);
        const passTxt = pass === 1 ? '単' : `MP×${pass}`;
        return `<option value="${t}"${line.expo === t ? ' selected' : ''}>${MACHINE_DEFS[k].short} (${passTxt})${owned ? '' : ' ⚠未所有'}</option>`;
      }))
      .join('');

    const est = game.estimateProfit(line.product, line.gen);
    const profitCls = est.profit >= 0 ? 'profit' : 'loss';

    host.innerHTML = `<h3>生産ライン設定</h3>
      <div class="cfgrow"><span>製品</span><select data-f="product">${prodOpts}</select></div>
      <div class="cfgrow"><span>ノード</span><select data-f="gen">${nodeOpts}</select></div>
      <div class="cfgrow"><span>露光</span><select data-f="expo">${expoOpts}</select></div>
      <div class="cfgrow"><span>投入間隔</span><input type="range" data-f="interval" min="2" max="20" step="1" value="${line.interval}"><b>${line.interval}s</b></div>
      <div class="pnl">
        <div class="prow"><span>出荷単価(見込)</span><b>¥${Math.round(est.revenue).toLocaleString()}</b></div>
        <div class="prow"><span>ウェハ原価</span><b>¥${est.waferCost.toLocaleString()}</b></div>
        <div class="prow ${profitCls}"><span>粗利/ロット</span><b>¥${Math.round(est.profit).toLocaleString()}</b></div>
      </div>`;

    host.querySelector<HTMLSelectElement>('[data-f="product"]')!.addEventListener('change', (e) => {
      line.product = (e.target as HTMLSelectElement).value as ProductId;
      cardSig = ''; // 製品変更でノード候補が変わるため再描画
    });
    host.querySelector<HTMLSelectElement>('[data-f="gen"]')!.addEventListener('change', (e) => {
      line.gen = Number((e.target as HTMLSelectElement).value);
      cardSig = '';
    });
    host.querySelector<HTMLSelectElement>('[data-f="expo"]')!.addEventListener('change', (e) => {
      line.expo = Number((e.target as HTMLSelectElement).value);
      cardSig = '';
    });
    const range = host.querySelector<HTMLInputElement>('[data-f="interval"]')!;
    range.addEventListener('input', () => {
      line.interval = Number(range.value);
      (range.nextElementSibling as HTMLElement).textContent = `${range.value}s`;
    });
  }

  // ---- 定期更新 ----
  function refresh() {
    const st = game.getStats();
    $('#stMoney').textContent = `¥${Math.floor(st.money).toLocaleString()}`;
    $('#stWip').textContent = String(st.wip);
    $('#stDone').textContent = String(st.completed);
    $('#stScrap').textContent = String(st.scrapped);
    $('#stTp').innerHTML = `${st.throughput.toFixed(1)}<i>/分</i>`;
    $('#stYield').textContent = st.avgYield > 0 ? `${(st.avgYield * 100).toFixed(1)}%` : '--';
    $('#stWait').textContent = st.avgWait > 0 ? `${st.avgWait.toFixed(1)}s` : '--';
    ($('#stPmWrap') as HTMLElement).hidden = st.pm === 0;
    $('#stPm').textContent = String(st.pm);
    $('#stOht').textContent = `${st.ohtTotal}/${st.ohtSize}台`;
    ($('#stOht') as HTMLElement).title =
      `稼働 ${st.ohtTotal - st.ohtIdle} / 待機 ${st.ohtIdle} / 保有枠 ${st.ohtSize}`;

    // 技術ツリーは開いている間だけ、状態が変わったら再描画
    if (!techPanel.classList.contains('hidden')) {
      const r = game.research;
      const tsig = `${[...game.nodesUnlocked].join(',')}|${[...game.productsUnlocked].join(',')}|${r ? r.type + Math.round(r.timeLeft * 4) : 'none'}|${Math.floor(game.money / 1000)}`;
      if (tsig !== techSig) { techSig = tsig; renderTech(); }
    }

    if (!flowPanel.classList.contains('hidden')) {
      const expo = game.resolveExpoTier(flowGen, -1);
      const sig =
        `${flowProduct}|${flowGen}|${expo}|${game.otherGenWipOf(flowProduct, flowGen)}|` +
        `${[...game.productsUnlocked].join(',')}|${[...game.nodesUnlocked].join(',')}|` +
        Math.round(game.freshnessOf(flowProduct, flowGen) * 100);
      if (sig !== flowSig) { flowSig = sig; rebuildFlow(); }

      const wipAll = game.stepWipOf(flowProduct, flowGen, expo);
      const rowWip = compactMap.map((cm) => {
        let n = 0;
        for (let k = cm.from; k < cm.from + cm.count && k < wipAll.length; k++) n += wipAll[k];
        return n;
      });
      const maxWip = Math.max(1, ...rowWip);
      rowWip.forEach((n, i) => {
        if (stepCnt[i]) {
          stepCnt[i].textContent = String(n);
          stepBar[i].style.width = `${(n / maxWip) * 100}%`;
        }
      });
      compactMap.forEach((cm, i) => {
        const u = game.kindUtil(cm.kind);
        if (stepUtil[i]) {
          stepUtil[i].textContent = u === null ? '--' : `${Math.round(u * 100)}%`;
          stepUtil[i].style.color =
            u === null ? 'var(--dim)' : u >= 0.85 ? '#cc4f44' : u >= 0.6 ? '#b07f19' : 'var(--dim)';
        }
        stepRows[i]?.classList.toggle('hl', vs.highlightKind === cm.kind);
      });
      sparkNow.textContent = `${st.throughput.toFixed(1)}/分`;
      drawSpark(st.throughput);
    }

    syncModeBtn();
    refreshCard();
  }

  return { refresh, syncTool, selectToolByKey, toggleFlow, toggleHeat, toggleTech, setTool };
}

// 出力FOUPの滞留理由を、プレイヤー向けの一文にする
function stallMessage(st: StallInfo): string {
  const name = MACHINE_DEFS[st.kind].name;
  if (st.reason === 'missing') return `次工程の装置「${name}」が未設置です`;
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
