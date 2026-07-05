import { MACHINE_DEFS, RECIPE } from './config';
import type { MachineKind } from './config';
import { Game } from './sim';
import type { RenderState } from './render';

const PLACEABLE: MachineKind[] = ['clean', 'depo', 'litho', 'etch', 'inspect'];

export function createUI(
  root: HTMLElement,
  game: Game,
  rs: RenderState,
): { refresh: () => void } {
  root.innerHTML = `
    <div class="box">
      <h2>装置パレット</h2>
      <div id="palette"></div>
      <button class="btn" id="deleteBtn" style="width:100%;margin-top:6px;text-align:center">🗑 撤去モード</button>
      <p class="dim" style="margin-top:6px">装置を選んで盤面をクリックで設置。右クリック / Esc で解除。</p>
    </div>
    <div class="box">
      <h2>コントロール</h2>
      <div id="controls">
        <button class="btn" id="pauseBtn">⏸ 一時停止</button>
        <button class="btn speedBtn" data-speed="1">1x</button>
        <button class="btn speedBtn" data-speed="2">2x</button>
        <button class="btn speedBtn" data-speed="4">4x</button>
      </div>
      <div style="margin-top:8px">
        <span class="dim">ロット投入間隔: <b id="spawnLabel"></b> 秒</span>
        <input type="range" id="spawnRange" min="2" max="15" step="1" />
      </div>
    </div>
    <div class="box">
      <h2>ライン状況</h2>
      <div class="statrow"><span>仕掛かり (WIP)</span><b id="stWip">0</b></div>
      <div class="statrow"><span>完成ロット</span><b id="stDone">0</b></div>
      <div class="statrow"><span>廃棄ロット</span><b id="stScrap">0</b></div>
      <div class="statrow"><span>スループット</span><b id="stTp">0.0 ロット/分</b></div>
      <div class="statrow"><span>平均歩留まり</span><b id="stYield">--%</b></div>
    </div>
    <div class="box">
      <h2>プロセスフロー(工程ごとの仕掛かり)</h2>
      <div id="recipe"></div>
    </div>
    <div class="box" id="machinebox" style="display:none">
      <h2>選択中の装置</h2>
      <div id="machineinfo"></div>
    </div>
  `;

  const $ = <T extends HTMLElement>(sel: string) =>
    root.querySelector(sel) as T;

  // ---- パレット ----
  const palette = $('#palette');
  const paletteBtns = new Map<MachineKind, HTMLButtonElement>();
  for (const kind of PLACEABLE) {
    const def = MACHINE_DEFS[kind];
    const btn = document.createElement('button');
    btn.innerHTML =
      `<span class="sw" style="background:${def.color}"></span>${def.name}` +
      `<small>${def.procTime}秒/ロット</small>`;
    btn.title = def.desc;
    btn.addEventListener('click', () => {
      rs.deleteMode = false;
      rs.placeKind = rs.placeKind === kind ? null : kind;
      syncModeButtons();
    });
    palette.appendChild(btn);
    paletteBtns.set(kind, btn);
  }

  const deleteBtn = $('#deleteBtn') as HTMLButtonElement;
  deleteBtn.addEventListener('click', () => {
    rs.placeKind = null;
    rs.deleteMode = !rs.deleteMode;
    syncModeButtons();
  });

  function syncModeButtons() {
    for (const [kind, btn] of paletteBtns) {
      btn.classList.toggle('active', rs.placeKind === kind);
    }
    deleteBtn.classList.toggle('active', rs.deleteMode);
  }

  // ---- コントロール ----
  const pauseBtn = $('#pauseBtn') as HTMLButtonElement;
  pauseBtn.addEventListener('click', () => {
    game.paused = !game.paused;
    pauseBtn.textContent = game.paused ? '▶ 再開' : '⏸ 一時停止';
  });
  const speedBtns = root.querySelectorAll<HTMLButtonElement>('.speedBtn');
  speedBtns.forEach((b) =>
    b.addEventListener('click', () => {
      game.speed = Number(b.dataset.speed);
      speedBtns.forEach((x) => x.classList.toggle('active', x === b));
    }),
  );
  speedBtns[0].classList.add('active');

  const spawnRange = $('#spawnRange') as HTMLInputElement;
  const spawnLabel = $('#spawnLabel');
  spawnRange.value = String(game.spawnInterval);
  spawnLabel.textContent = String(game.spawnInterval);
  spawnRange.addEventListener('input', () => {
    game.spawnInterval = Number(spawnRange.value);
    spawnLabel.textContent = spawnRange.value;
  });

  // ---- レシピ表示 ----
  const recipeBox = $('#recipe');
  const stepCnt: HTMLElement[] = [];
  const stepBar: HTMLElement[] = [];
  RECIPE.forEach((step, i) => {
    const def = MACHINE_DEFS[step.kind];
    const row = document.createElement('div');
    row.className = 'step';
    row.innerHTML =
      `<span class="sw" style="background:${def.color}"></span>` +
      `<span>${i + 1}. ${step.label}</span>` +
      `<span class="bar"><i style="width:0%"></i></span>` +
      `<span class="cnt">0</span>`;
    recipeBox.appendChild(row);
    stepBar.push(row.querySelector('.bar i') as HTMLElement);
    stepCnt.push(row.querySelector('.cnt') as HTMLElement);
  });

  // ---- 装置情報 ----
  const machineBox = $('#machinebox');
  const machineInfo = $('#machineinfo');
  let infoSignature = ''; // 表示内容が変わったときだけDOMを作り直す(ボタン操作の安定のため)

  function refresh() {
    const st = game.getStats();
    $('#stWip').textContent = String(st.wip);
    $('#stDone').textContent = String(st.completed);
    $('#stScrap').textContent = String(st.scrapped);
    $('#stTp').textContent = `${st.throughput.toFixed(1)} ロット/分`;
    $('#stYield').textContent =
      st.completed > 0 ? `${(st.avgYield * 100).toFixed(1)}%` : '--%';

    const maxWip = Math.max(1, ...st.stepWip);
    st.stepWip.forEach((n, i) => {
      stepCnt[i].textContent = String(n);
      stepBar[i].style.width = `${(n / maxWip) * 100}%`;
    });

    // 選択装置パネル
    const m = rs.selected;
    if (!m || !game.machines.includes(m)) {
      rs.selected = null;
      machineBox.style.display = 'none';
      infoSignature = '';
      return;
    }
    machineBox.style.display = '';
    const def = MACHINE_DEFS[m.kind];
    const status =
      m.maintLeft > 0
        ? `整備中 (残り${Math.ceil(m.maintLeft)}秒)`
        : m.busyLot
          ? '処理中'
          : '待機中';
    const sig = `${m.id}|${status}|${m.cleanliness.toFixed(2)}|${m.jobs}`;
    if (sig === infoSignature) return;
    infoSignature = sig;
    machineInfo.innerHTML = `
      <div class="statrow"><span>装置</span><b>${def.name}</b></div>
      <div class="statrow"><span>状態</span><b>${status}</b></div>
      <div class="statrow"><span>清浄度</span><b>${(m.cleanliness * 100).toFixed(0)}%</b></div>
      <div class="statrow"><span>処理ジョブ数</span><b>${m.jobs}</b></div>
      <p class="dim" style="margin-top:4px">${def.desc}</p>
    `;
    if (def.placeable) {
      const maintBtn = document.createElement('button');
      maintBtn.className = 'btn';
      maintBtn.textContent = '🔧 メンテナンス (8秒)';
      maintBtn.disabled = m.busyLot !== null || m.maintLeft > 0;
      maintBtn.addEventListener('click', () => game.startMaintenance(m));
      const delBtn = document.createElement('button');
      delBtn.className = 'btn danger';
      delBtn.textContent = '🗑 撤去';
      delBtn.addEventListener('click', () => {
        if (game.removeMachine(m)) rs.selected = null;
      });
      machineInfo.appendChild(maintBtn);
      machineInfo.appendChild(delBtn);
    }
  }

  // 外部(main.ts)からモード変更されたときのために公開
  root.addEventListener('modechange', syncModeButtons);

  return { refresh };
}
