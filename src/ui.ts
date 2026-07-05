// HTMLオーバーレイのHUD: 上部ステータスストリップ、下部ホットバー、
// 選択装置のコンテキストカード、工程フローパネル。

import { MACHINE_DEFS, RECIPE, MAX_FLEET, TILE } from './config';
import type { MachineKind } from './config';
import { Game } from './sim';
import type { ViewState, Tool } from './render';

interface UIOpts {
  root: HTMLElement;
  game: Game;
  vs: ViewState;
  worldToScreen: (x: number, y: number) => { x: number; y: number };
}

interface ToolDef {
  key: string;
  name: string;
  tool: Tool;
  drawIcon: (ctx: CanvasRenderingContext2D) => void;
}

const PLACEABLE: MachineKind[] = ['clean', 'depo', 'litho', 'etch', 'inspect', 'stocker'];

export function createUI(opts: UIOpts) {
  const { root, game, vs, worldToScreen } = opts;

  root.innerHTML = `
    <header id="topbar">
      <div class="brand">半導体工場シミュレーター<span class="tag">PROTO</span></div>
      <div class="stats">
        <span class="stat"><label>仕掛かり</label><b id="stWip">0</b></span>
        <span class="stat"><label>完成</label><b id="stDone">0</b></span>
        <span class="stat"><label>廃棄</label><b id="stScrap">0</b></span>
        <span class="stat"><label>スループット</label><b id="stTp">0.0<i>/分</i></b></span>
        <span class="stat"><label>歩留まり</label><b id="stYield">--</b></span>
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
        <button id="flowBtn" class="tbtn on" title="工程フロー表示 (F)">工程</button>
      </div>
    </header>
    <aside id="flow"></aside>
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
      drawIcon: (c: CanvasRenderingContext2D) => iconMachine(c, MACHINE_DEFS[kind].accent, MACHINE_DEFS[kind].w),
    })),
    { key: '0', name: '装置撤去', tool: { mode: 'demolish', kind: null }, drawIcon: iconDemolish },
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
    const td = toolDefs.find((t) => t.key === key);
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

  // ---- 工程フローパネル ----
  flowPanel.innerHTML =
    `<h2>プロセスフロー</h2>` +
    RECIPE.map(
      (s, i) => `
      <div class="step">
        <span class="sw" style="background:${MACHINE_DEFS[s.kind].accent}"></span>
        <span class="nm">${i + 1}. ${s.label}</span>
        <span class="bar"><i></i></span>
        <b class="cnt">0</b>
      </div>`,
    ).join('');
  const stepCnt = [...flowPanel.querySelectorAll<HTMLElement>('.cnt')];
  const stepBar = [...flowPanel.querySelectorAll<HTMLElement>('.bar i')];

  // ---- コンテキストカード ----
  const card = $('#ctxcard');
  let cardSig = '';

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

    // 画面上の装置右肩に追従
    const p = worldToScreen((m.col + def.w) * TILE, (m.row - 0.4) * TILE);
    card.style.left = `${Math.min(window.innerWidth - 240, Math.max(8, p.x + 8))}px`;
    card.style.top = `${Math.min(window.innerHeight - 220, Math.max(52, p.y))}px`;

    const status =
      m.maintLeft > 0 ? `整備中 残り${Math.ceil(m.maintLeft)}s`
      : m.busyLot ? '処理中'
      : m.holdLot ? '出力待ち(ポート満杯)'
      : '待機中';
    const portDots = (io: 'in' | 'out') =>
      m.ports.filter((x) => x.io === io).map((x) => (x.foup ? '●' : '○')).join('');
    const sig = `${m.id}|${status}|${m.cleanliness.toFixed(2)}|${m.jobs}|${portDots('in')}|${portDots('out')}|${m.noRoute}|${m.storage.length}`;
    if (sig === cardSig) return;
    cardSig = sig;

    card.style.borderTopColor = def.accent;
    card.innerHTML = `
      <div class="head"><span class="nm">${def.name}</span><span class="lbl">${m.label}</span></div>
      <div class="row"><span>状態</span><b>${status}</b></div>
      <div class="row"><span>清浄度</span>
        <span class="gauge"><i style="width:${m.cleanliness * 100}%;background:${
          m.cleanliness > 0.6 ? '#3f9c5a' : m.cleanliness > 0.35 ? '#d99a2b' : '#cc4f44'
        }"></i></span><b>${(m.cleanliness * 100).toFixed(0)}%</b></div>
      ${m.kind === 'stocker'
        ? `<div class="row"><span>保管数</span><b>${m.storage.length} / 6</b></div>`
        : `<div class="row"><span>処理数</span><b>${m.jobs}</b></div>`}
      <div class="row"><span>ポート</span><b>IN ${portDots('in') || 'ー'}&nbsp; OUT ${portDots('out') || 'ー'}</b></div>
      ${m.noRoute ? '<div class="alert">次工程へのレール経路がありません</div>' : ''}
      <div class="btns"></div>
    `;
    const btns = card.querySelector('.btns')!;
    if (def.placeable) {
      if (m.kind !== 'stocker') {
        const maint = document.createElement('button');
        maint.textContent = 'メンテナンス';
        maint.disabled = m.busyLot !== null || m.maintLeft > 0;
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
    $('#stOht').textContent = `${st.ohtTotal}/${st.ohtSize}台`;
    ($('#stOht') as HTMLElement).title =
      `稼働 ${st.ohtTotal - st.ohtIdle} / 待機 ${st.ohtIdle} / 保有枠 ${st.ohtSize}`;

    const maxWip = Math.max(1, ...st.stepWip);
    st.stepWip.forEach((n, i) => {
      stepCnt[i].textContent = String(n);
      stepBar[i].style.width = `${(n / maxWip) * 100}%`;
    });

    refreshCard();
  }

  return { refresh, syncTool, selectToolByKey, toggleFlow, setTool };
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
