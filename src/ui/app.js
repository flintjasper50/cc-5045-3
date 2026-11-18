'use strict';
// Task panel driven by the kernel descriptor: controls are generated from
// /api/kernel, jobs stream over SSE, and every failure is surfaced verbatim.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const state = {
  kernel: null,
  filters: [],          // [{type, params:{key:value}}]
  plan: null,
  scene: null,
  run: null,
  zoom: 'fit',
  selected: null,
  hoverTile: null,
  image: null,          // full poster Image (browser decodes once; tiles still come from kernel)
  refImage: null,
  view: { x: 0, y: 0, scale: 1 },
  dragging: false,
  needBitmap: false,
  activeRun: null,
};

function fmt(n, d = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: d });
}
function mb(n) { return n == null ? '—' : `${fmt(n, 1)} MB`; }
function pct(n) { return n == null ? '—' : `${fmt(n * 100, 1)}%`; }

async function boot() {
  try {
    state.kernel = await (await fetch('/api/kernel')).json();
  } catch (err) {
    showError('无法连接内核: ' + err.message);
    return;
  }
  $('#kernelVer').textContent = 'kernel ' + state.kernel.version;
  buildSceneSelect();
  buildFilterPalette();
  addFilter('blur');
  bindUI();
  await previewPlan();
}

function buildSceneSelect() {
  const sel = $('#scene');
  sel.innerHTML = '';
  for (const s of state.kernel.scenes) {
    const o = document.createElement('option');
    o.value = s.id; o.textContent = s.label; o.title = s.note;
    sel.append(o);
  }
  sel.value = 'grid';
}

function buildFilterPalette() {
  const wrap = $('#addFilters');
  wrap.innerHTML = '';
  for (const f of state.kernel.filters) {
    const b = document.createElement('button');
    b.textContent = '+ ' + f.label;
    b.title = f.description;
    b.onclick = () => addFilter(f.type);
    wrap.append(b);
  }
}

function filterDef(type) { return state.kernel.filters.find(f => f.type === type); }

function addFilter(type) {
  const def = filterDef(type);
  if (!def) return;
  if (state.filters.length >= 6) { showError('滤镜最多 6 个'); return; }
  const params = {};
  for (const p of def.params) params[p.key] = p.default;
  state.filters.push({ type, params });
  renderFilters();
  previewPlan();
}

function renderFilters() {
  const wrap = $('#filters');
  wrap.innerHTML = '';
  $('#filterCount').textContent = state.filters.length ? `${state.filters.length} 个` : '空';
  if (!state.filters.length) {
    wrap.innerHTML = '<div class="hint" style="border:1px dashed var(--line);border-radius:6px;padding:10px;text-align:center;margin:0">未添加滤镜：直接输出原始画面</div>';
    return;
  }
  state.filters.forEach((f, i) => {
    const def = filterDef(f.type);
    const card = document.createElement('div');
    card.className = 'fcard';
    const head = document.createElement('div');
    head.className = 'fhead';
    head.innerHTML = `<span class="n">${i + 1}</span><span class="nm">${def.label}</span>`;
    const up = document.createElement('button'); up.textContent = '↑'; up.title = '上移';
    up.onclick = () => moveFilter(i, -1);
    const dn = document.createElement('button'); dn.textContent = '↓'; dn.title = '下移';
    dn.onclick = () => moveFilter(i, 1);
    const rm = document.createElement('button'); rm.textContent = '×'; rm.title = '移除';
    rm.onclick = () => { state.filters.splice(i, 1); renderFilters(); previewPlan(); };
    head.append(up, dn, rm);
    const body = document.createElement('div');
    body.className = 'fbody';
    for (const p of def.params) body.append(paramControl(f, p));
    card.append(head, body);
    card.title = def.description;
    wrap.append(card);
  });
}

function moveFilter(i, d) {
  const j = i + d;
  if (j < 0 || j >= state.filters.length) return;
  const [x] = state.filters.splice(i, 1);
  state.filters.splice(j, 0, x);
  renderFilters();
  previewPlan();
}

function paramControl(f, p) {
  const row = document.createElement('div');
  row.className = 'ctl';
  const label = document.createElement('label');
  label.textContent = p.label;
  const val = document.createElement('span');
  val.className = 'val';
  if (p.type === 'color') {
    const inp = document.createElement('input');
    inp.type = 'color'; inp.value = f.params[p.key];
    inp.oninput = () => { f.params[p.key] = inp.value; val.textContent = inp.value.toUpperCase(); schedulePreview(); };
    row.append(label, inp, val);
    val.textContent = String(f.params[p.key]).toUpperCase();
    return row;
  }
  const inp = document.createElement('input');
  inp.type = 'range';
  inp.min = p.min; inp.max = p.max; inp.step = p.step;
  inp.value = f.params[p.key];
  const show = () => {
    const v = Number(f.params[p.key]);
    val.textContent = Number.isInteger(p.step) ? String(v) : v.toFixed(p.step < 0.1 ? 2 : 1);
  };
  inp.oninput = () => { f.params[p.key] = Number(inp.value); show(); schedulePreview(); };
  show();
  row.append(label, inp, val);
  return row;
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(previewPlan, 220);
}

function currentJob() {
  const failRaw = $('#failInject').value.trim();
  const failInject = failRaw ? failRaw.split(/[,\s]+/).map(Number).filter(Number.isFinite) : [];
  return {
    scene: $('#scene').value,
    width: Number($('#width').value),
    height: Number($('#height').value),
    tileW: Number($('#tileW').value),
    tileH: Number($('#tileW').value),
    filters: state.filters.map(f => ({ type: f.type, ...f.params })),
    failInject,
  };
}

async function previewPlan() {
  const job = currentJob();
  try {
    const res = await fetch('/api/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job) });
    const data = await res.json();
    if (!res.ok) { showError(data.error || '预演失败'); return; }
    clearError();
    state.plan = data.plan;
    state.scene = data.scene;
    renderGridInfo(data.plan);
    renderRangeTable(data.plan);
    renderTileTable(data.plan, state.run);
    if (!state.record) drawGridPreview(job, data.plan);
  } catch (err) {
    showError('预演请求失败: ' + err.message);
  }
}

function renderGridInfo(plan) {
  $('#gridTag').textContent = `${plan.cols} × ${plan.rows}`;
  $('#gridMeta').textContent = `网格 ${plan.cols}×${plan.rows} · ${plan.tiles} 块 · 最大邻域 ${plan.maxHalo}px`;
  $('#gridHint').innerHTML = `每块计算范围平均放大 <b>${fmt(plan.extraRatioMean * 100, 0)}%</b>，最多 <b>${fmt(plan.extraRatioMax * 100, 0)}%</b>。`;
}

function drawGridPreview(job, plan) {
  // Draw a plan-only schematic on a canvas sized to the document aspect.
  const maxW = Math.max(360, $('#viewer').clientWidth - 80);
  const maxH = Math.max(260, $('#viewer').clientHeight - 80);
  const s = Math.min(maxW / job.width, maxH / job.height, 1);
  const cw = Math.max(64, Math.round(job.width * s));
  const ch = Math.max(64, Math.round(job.height * s));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  canvas.id = 'poster';
  canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
  const g = canvas.getContext('2d');
  g.fillStyle = '#0a1420'; g.fillRect(0, 0, cw, ch);
  // document outline
  g.strokeStyle = '#2c4157'; g.lineWidth = 1; g.strokeRect(.5, .5, cw - 1, ch - 1);
  g.strokeStyle = 'rgba(240,181,61,.35)';
  for (const t of plan.tileList) {
    g.strokeRect((t.contentRect.x0 / job.width) * cw, (t.contentRect.y0 / job.height) * ch,
      ((t.contentRect.x1 - t.contentRect.x0) / job.width) * cw, ((t.contentRect.y1 - t.contentRect.y0) / job.height) * ch);
  }
  g.strokeStyle = 'rgba(56,217,181,.9)';
  for (const t of plan.tileList) {
    g.strokeRect((t.crop.x0 / job.width) * cw, (t.crop.y0 / job.height) * ch,
      ((t.crop.x1 - t.crop.x0) / job.width) * cw, ((t.crop.y1 - t.crop.y0) / job.height) * ch);
  }
  g.fillStyle = 'rgba(220,232,242,.65)'; g.font = '11px ui-monospace,monospace';
  g.fillText('预演：绿色=输出块，暗黄=计算范围（含邻域）', 10, ch - 12);
  $('#stage').innerHTML = '';
  $('#stage').append(canvas);
  state.image = null;
  state.record = null;
}

function renderRangeTable(plan) {
  const rows = plan.tileList.slice(0, 40).map(t =>
    `<div class="kv"><span>#${t.index} 行${t.row} 列${t.col} · 输出 ${t.crop.x1 - t.crop.x0}×${t.crop.y1 - t.crop.y0}</span>
     <b>计算 ${t.computeW}×${t.computeH}</b></div>
     <div class="kv" style="border:0;padding-top:0"><span>邻域 左${t.halo.left} 上${t.halo.top} 右${t.halo.right} 下${t.halo.bottom}</span><b>+${fmt((t.extraRatio - 1) * 100, 0)}%</b></div>`
  ).join('');
  $('#rangeTable').innerHTML = rows + (plan.tileList.length > 40 ? `<p class="hint">仅显示前 40 块，共 ${plan.tileList.length} 块。</p>` : '');
}

function renderTileTable(plan, run) {
  const tbl = $('#tileTable');
  const edgeMap = new Map();
  if (run && run.reference && run.reference.edge && run.reference.edge.perTile) {
    for (const e of run.reference.edge.perTile) edgeMap.set(e.index, e.maxDiff);
  }
  const cmpMap = new Map();
  if (run && run.reference && run.reference.perTile) for (const e of run.reference.perTile) cmpMap.set(e.index, e.maxDiff);
  tbl.innerHTML = `<thead><tr><th>#</th><th>行/列</th><th>输出</th><th>计算</th><th>邻域</th><th>边差</th></tr></thead>`;
  const tb = document.createElement('tbody');
  for (const t of plan.tileList) {
    const tr = document.createElement('tr');
    tr.dataset.index = t.index;
    if (state.selected === t.index) tr.className = 'sel';
    const edge = edgeMap.has(t.index) ? edgeMap.get(t.index) : (cmpMap.has(t.index) ? cmpMap.get(t.index) : null);
    tr.innerHTML = `<td>${t.index}</td><td>${t.row}/${t.col}</td>
      <td>${t.crop.x1 - t.crop.x0}×${t.crop.y1 - t.crop.y0}</td>
      <td>${t.computeW}×${t.computeH}</td>
      <td>${t.halo.left}/${t.halo.top}/${t.halo.right}/${t.halo.bottom}</td>
      <td class="diff">${edge == null ? '—' : edge}</td>`;
    tr.onclick = () => selectTile(t.index);
    tb.append(tr);
  }
  tbl.append(tb);
}

function selectTile(index) {
  state.selected = index;
  $$('#tileTable tbody tr').forEach(tr => tr.classList.toggle('sel', Number(tr.dataset.index) === index));
  const t = state.plan && state.plan.tileList.find(x => x.index === index);
  if (!t) { renderOverlay(); return; }
  $('#cursorPos').textContent = `块 #${index} 输出 x${t.crop.x0} y${t.crop.y0}`;
  if (state.record) {
    // zoom until the tile fills most of the viewport
    const stage = $('#stage');
    const vw = Math.max(64, stage.clientWidth - 72);
    const vh = Math.max(64, stage.clientHeight - 72);
    const z = Math.max(fitScale(), Math.min(8, vw / (t.crop.x1 - t.crop.x0), vh / (t.crop.y1 - t.crop.y0)));
    state.zoom = z <= fitScale() * 1.001 ? 'fit' : String(+z.toFixed(2));
    $$('.zoombar button').forEach(x => x.classList.toggle('on', x.dataset.z === state.zoom));
    viewToken++;
    state.viewKey = null;
    const vp = layoutWrap();
    if (state.zoom !== 'fit') {
      // scroll so the tile centre lands in the middle of the viewport
      stage.scrollLeft = (t.crop.x0 + (t.crop.x1 - t.crop.x0) / 2) * vp.sx - stage.clientWidth / 2;
      stage.scrollTop = (t.crop.y0 + (t.crop.y1 - t.crop.y0) / 2) * vp.sy - stage.clientHeight / 2;
    }
    refreshView(true);
    return;
  }
  renderOverlay();
}

function bindUI() {
  $('#scene').onchange = () => { state.image = null; state.record = null; previewPlan(); };
  for (const id of ['#width', '#height', '#tileW']) {
    $(id).addEventListener('input', () => { state.image = null; state.record = null; schedulePreview(); });
  }
  $$('#tilePreset button').forEach(b => b.onclick = () => {
    $$('#tilePreset button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    $('#tileW').value = b.dataset.t;
    state.image = null; state.record = null;
    previewPlan();
  });
  $$('#scenePresets button').forEach(b => b.onclick = () => {
    const p = b.dataset.preset;
    if (p === 'small') { $('#width').value = 1024; $('#height').value = 1024; }
    if (p === 'mid') { $('#width').value = 4096; $('#height').value = 3072; }
    if (p === 'poster') { $('#width').value = 12000; $('#height').value = 9000; }
    state.image = null; state.record = null;
    previewPlan();
  });
  $('#previewBtn').onclick = previewPlan;
  $('#gridCmpBtn').onclick = runGridCompare;
  $('#runBtn').onclick = submitRun;
  $$('#tabs button').forEach(b => b.onclick = () => {
    $$('#tabs button').forEach(x => x.classList.toggle('on', x === b));
    for (const id of ['#tabResult', '#tabTiles', '#tabMemory', '#tabEvents']) $(id).classList.add('hidden');
    $('#tab' + b.dataset.tab[0].toUpperCase() + b.dataset.tab.slice(1)).classList.remove('hidden');
  });
  $$('.zoombar button').forEach(b => b.onclick = () => {
    $$('.zoombar button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    setZoom(b.dataset.z);
  });
  window.addEventListener('resize', () => { renderOverlay(); applyZoomMode(state.record ? centerDocPoint() : null); });
}

// ---------------------------------------------------------------- run
async function submitRun() {
  const job = currentJob();
  $('#runBtn').disabled = true;
  $('#previewBtn').disabled = true;
  clearError();
  setStatus('busy', '提交任务…');
  $('#prog').style.width = '0%';
  $('#events').innerHTML = '';
  state.run = null;
  state.selected = null;

  let resp;
  try {
    resp = await fetch('/api/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(job) });
  } catch (err) {
    setStatus('bad', '连接失败');
    showError('无法提交: ' + err.message);
    $('#runBtn').disabled = false; $('#previewBtn').disabled = false;
    return;
  }
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { msg = (await resp.json()).error || msg; } catch (_) {}
    setStatus('bad', '提交被拒');
    showError(msg);
    $('#runBtn').disabled = false; $('#previewBtn').disabled = false;
    return;
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
        handleSSE(raw);
      }
    }
  } catch (err) {
    showError('任务流中断: ' + err.message);
    setStatus('bad', '流中断');
  }
  $('#runBtn').disabled = false; $('#previewBtn').disabled = false;
}

async function runGridCompare() {
  const job = currentJob();
  const btn = $('#gridCmpBtn');
  const box = $('#gridCmp');
  btn.disabled = true;
  box.innerHTML = '正在按多个网格分别渲染并对照整幅参照…';
  try {
    const res = await fetch('/api/grids', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scene: job.scene, width: job.width, height: job.height, filters: job.filters, tileSizes: [64, 128, 256, 512] }),
    });
    const data = await res.json();
    if (!res.ok) { box.innerHTML = `<span style="color:var(--bad)">${data.error || '对比失败'}</span>`; return; }
    const rows = data.results.map(r => `
      <tr>
        <td>${r.tileSize}</td>
        <td>${r.tiles}</td>
        <td>${r.maxHalo}</td>
        <td class="diff">${r.edgeMaxDiff}</td>
        <td>${r.edgeMeanDiff}</td>
        <td>${r.allMaxDiff}</td>
      </tr>`).join('');
    box.innerHTML = `
      <table class="tiletable" style="margin-top:4px">
        <thead><tr><th>块边长</th><th>块数</th><th>邻域</th><th>边缘最大差</th><th>边缘均差</th><th>全图最大差</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="hint" style="margin-top:7px">每个网格都与同一张整幅参照逐像素比较。边缘差指块边界 2px 带内的最大差；全为 0 表示换网格不改变画面。</p>`;
  } catch (err) {
    box.innerHTML = `<span style="color:var(--bad)">对比请求失败: ${err.message}</span>`;
  } finally {
    btn.disabled = false;
  }
}

function handleSSE(raw) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
  }
  if (!dataLines.length) return;
  let data;
  try { data = JSON.parse(dataLines.join('\n')); } catch (_) { return; }
  switch (event) {
    case 'accepted':
      state.activeRun = data.jobId;
      setStatus('busy', '已提交，等待网格');
      break;
    case 'plan': {
      state.plan = data.plan;
      renderGridInfo(data.plan);
      renderRangeTable(data.plan);
      renderTileTable(data.plan, null);
      setStatus('busy', `执行中 · ${data.cache.missing}/${data.cache.total} 块待算`);
      updateProgress(0, data.plan.tiles, `缓存命中 ${data.cache.cached}`);
      break;
    }
    case 'tile':
      updateProgress(data.done, data.total, `节点 ${data.peakRssMb ? fmt(data.peakRssMb, 0) + 'MB' : ''}`);
      break;
    case 'retry':
      logEvent('retry', `块 #${data.index} 第 ${data.attempt} 次失败 → 重新排入队列`);
      setStatus('busy', `节点失败，重做块 #${data.index}`);
      break;
    case 'failed':
      state.run = { ...data, failed: true };
      setStatus('bad', '任务失败（部分块未完成）');
      showFailures(data.failures, data.events);
      logEvent('failed', `失败块 ${data.failures.map(f => '#' + f.index).join(', ')}`);
      renderStats({ ...data, plan: state.plan });
      break;
    case 'error':
      setStatus('bad', '内核错误');
      showError(data.message);
      logEvent('failed', String(data.message).split('\n')[0]);
      break;
    case 'done':
      setStatus('ok', '完成');
      $('#prog').style.width = '100%';
      onDone(data);
      break;
    default: break;
  }
}

function updateProgress(done, total, extra) {
  const p = total ? Math.round(done / total * 100) : 0;
  $('#prog').style.width = p + '%';
  $('#progressMeta').textContent = `${done}/${total} 块 ${extra ? '· ' + extra : ''}`;
}

function logEvent(kind, text) {
  const el = $('#events');
  if (el.textContent === '—') el.textContent = '';
  const line = document.createElement('div');
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  line.className = kind;
  line.textContent = `[${stamp}] ${text}`;
  el.prepend(line);
}

async function onDone(record) {
  state.run = record;
  renderStats(record);
  renderTileTable(record.plan, record);
  renderTilesForRun(record);
  renderDiff(record);
  renderMemory(record);
  renderEvents(record);
  $('#placeholder')?.remove();
  await loadPoster(record);
  setStatus('ok', `完成 · ${record.stats.wallMs}ms · ${record.stats.tiles} 块`);
}

function renderTilesForRun(record) {
  // record.plan is a summary; keep its tileList form for tables and overlays
  state.plan = record.plan;
  renderGridInfo(record.plan);
  renderRangeTable(record.plan);
}

function renderStats(record) {
  const s = record.stats || {};
  $('#progressMeta').textContent = `${s.tiles || 0} 块 · ${s.wallMs || 0}ms`;
}

function renderDiff(record) {
  const ref = record.reference;
  if (!ref) {
    $('#refSummary').textContent = '该画幅超过参照渲染上限（6M 像素），未生成整幅对比。分块仍与相邻块一致。';
    $('#cmpWrap').classList.add('hidden');
    $('#diffList').innerHTML = '';
    return;
  }
  if (ref.error) {
    $('#refSummary').textContent = '参照渲染失败: ' + ref.error;
    $('#cmpWrap').classList.add('hidden');
    return;
  }
  $('#refSummary').innerHTML = `与整幅参照比较：最大差 <b>${ref.maxDiff}</b> / 255，平均差 <b>${ref.meanDiff}</b>，覆盖 <b>${fmt(ref.pixels, 0)}</b> 像素。`;
  $('#diffList').innerHTML = `
    <div class="scale"><span>0</span><span>边界最大差</span><span>255</span></div>
    <div class="kv"><span>边缘带（2px）最大差</span><b>${ref.edge ? ref.edge.maxDiff : '—'}</b></div>
    <div class="kv"><span>边缘带平均差</span><b>${ref.edge ? ref.edge.meanDiff : '—'}</b></div>
    <div class="kv"><span>最差块</span><b>${ref.worst ? '#' + ref.worst.index + '（' + ref.worst.maxDiff + '）' : '—'}</b></div>
    <p class="hint">整幅参照仅在 ≤6M 像素的小样上生成，用于验证分块实现；大图依靠块间/缓存一致性保证。</p>`;
  const cmp = $('#cmpWrap');
  cmp.classList.remove('hidden');
  const t = pickCrop(record);
  if (t) {
    $('#cmpPoster').src = `/api/runs/${record.jobId}/crop.png?x=${t.x}&y=${t.y}&w=${t.w}&h=${t.h}`;
    $('#cmpRef').src = `/api/runs/${record.jobId}/refcrop.png?x=${t.x}&y=${t.y}&w=${t.w}&h=${t.h}`;
    $('#cmpPosterCap').textContent = `x${t.x} y${t.y} ${t.w}×${t.h}`;
    $('#cmpRefCap').textContent = '同区域';
  }
}

function pickCrop(record) {
  // Prefer the worst error tile, else a seam between two tiles.
  const r = record.reference;
  if (r && r.worst) {
    const t = record.plan.tileList.find(x => x.index === r.worst.index);
    if (t) {
      const pad = 24;
      return {
        x: Math.max(0, t.crop.x0 - pad), y: Math.max(0, t.crop.y0 - pad),
        w: Math.min(256, t.crop.x1 - t.crop.x0 + pad), h: Math.min(256, t.crop.y1 - t.crop.y0 + pad),
      };
    }
  }
  const t = record.plan.tileList[0];
  return t ? { x: t.crop.x0, y: t.crop.y0, w: Math.min(256, t.crop.x1 - t.crop.x0), h: Math.min(256, t.crop.y1 - t.crop.y0) } : null;
}

function renderMemory(record) {
  const m = record.memory;
  const peakNote = record.stats && record.stats.peakNodeFromCache
    ? ' <span class="warn">（本次全部命中缓存，取自该作业的历史峰值）</span>' : '';
  $('#memGrid').innerHTML = `
    <span>节点峰值 RSS</span><b>${mb(m.nodePeakMb)}${peakNote}</b>
    <span>节点内存上限</span><b>${mb(m.nodeLimitMb)}</b>
    <span>导出一条带峰值</span><b>${mb(m.exportStripPeakMb)}</b>
    <span>主进程 RSS</span><b>${mb(m.coordinatorRssMb)}</b>
    <span>导出尺寸</span><b>${fmt(record.export.width)} × ${fmt(record.export.height)}</b>
    <span>导出字节</span><b>${mb(record.export.bytes / 1048576)}</b>`;
  $('#cacheGrid').innerHTML = `
    <span>复用缓存块</span><b>${record.cache.reused}</b>
    <span>本次渲染块</span><b>${record.cache.rendered}</b>
    <span>失败重做块</span><b>${record.cache.retried}</b>`;
  $('#memGrid').innerHTML += `<span>内核版本</span><b>${state.kernel.version}</b>`;
}

function renderEvents(record) {
  $('#failures').innerHTML = (record.events || []).length
    ? record.events.map(e => `<div class="kv"><span>块 #${e.tile} · ${e.kind}</span><b>${e.error ? String(e.error).slice(0, 90) : ''}</b></div>`).join('')
    : '<span class="hint">无失败</span>';
  if (record.events) {
    for (const e of record.events) {
      logEvent(e.kind, `块 #${e.tile} ${e.kind === 'retry' ? '重排' : '失败'}: ${String(e.error).split('\n')[0]}`);
    }
  }
}

// ---------------------------------------------------------------- poster viewer
// The viewer never decodes the whole document. At fit scale it asks for a
// downscaled overview built from tile files; when zoomed it requests only the
// visible document window and positions that crop at its document offset.
// Both the browser and the coordinator therefore stay bounded.
function docSize() {
  return state.plan
    ? { w: state.plan.docW, h: state.plan.docH }
    : { w: state.record.export.width, h: state.record.export.height };
}

async function loadPoster(record) {
  state.record = record;
  state.zoom = 'fit';
  $$('.zoombar button').forEach(x => x.classList.toggle('on', x.dataset.z === 'fit'));
  createViewer();
  await refreshView(true);
}

function createViewer() {
  const stage = $('#stage');
  stage.innerHTML = '';
  stage.style.display = 'block';
  stage.style.overflow = 'auto';
  const wrap = document.createElement('div');
  wrap.id = 'posterWrap';
  wrap.style.position = 'relative';
  wrap.style.overflow = 'hidden';
  wrap.style.background = '#05080b';
  wrap.style.boxShadow = '0 0 0 1px #000';
  const img = document.createElement('img');
  img.id = 'poster';
  img.style.position = 'absolute';
  img.style.left = '0'; img.style.top = '0';
  img.style.imageRendering = 'pixelated';
  img.draggable = false;
  img.alt = '拼接结果';
  const stale = $('#overlay');
  if (stale) stale.remove();
  const ov = document.createElement('canvas');
  ov.id = 'overlay';
  // The overlay lives in the viewer (not in the document-sized box): at deep
  // zoom the document box can be far larger than the browser's max canvas
  // size, so it is sized to the viewport and redrawn on scroll.
  ov.style.position = 'absolute'; ov.style.left = '0'; ov.style.top = '0'; ov.style.pointerEvents = 'none';
  $('#viewer').append(ov);
  wrap.append(img);
  stage.append(wrap);
  bindCanvasEvents(img);
  stage.addEventListener('scroll', () => {
    if (!state.record || state.zoom === 'fit') return;
    renderOverlay(); // rects track the scrolled image immediately
    clearTimeout(state.scrollTimer);
    state.scrollTimer = setTimeout(() => refreshView(false), 90);
  });
}

function zoomScale() {
  if (!state.record || state.zoom === 'fit') return fitScale();
  return Number(state.zoom) || fitScale();
}

function viewportRect() {
  const { w, h } = docSize();
  const s = zoomScale();
  if (state.zoom === 'fit') {
    const vw = Math.max(64, $('#viewer').clientWidth - 48);
    const vh = Math.max(64, $('#viewer').clientHeight - 48);
    const f = Math.min(vw / w, vh / h, 1);
    const ww = Math.max(64, Math.round(w * f)), hh = Math.max(64, Math.round(h * f));
    return { w: ww, h: hh, sx: f, sy: f, fit: true };
  }
  return { w: Math.round(w * s), h: Math.round(h * s), sx: s, sy: s, fit: false };
}

function layoutWrap() {
  const wrap = document.getElementById('posterWrap');
  if (!wrap) return null;
  const stage = $('#stage');
  const vp = viewportRect();
  wrap.style.width = vp.w + 'px';
  wrap.style.height = vp.h + 'px';
  if (vp.fit) {
    stage.style.display = 'flex';
    stage.style.alignItems = 'center';
    stage.style.justifyContent = 'center';
    stage.style.justifyItems = 'normal';
    wrap.style.margin = '0';
  } else {
    // scroll container: the document box must start at the origin so that
    // scrollLeft/scrollTop map directly onto document coordinates. The stylesheet
    // centres grid children, so reset placement explicitly.
    stage.style.display = 'block';
    stage.style.alignItems = 'normal';
    stage.style.justifyContent = 'normal';
    stage.style.justifyItems = 'normal';
    stage.style.placeItems = 'normal';
    wrap.style.margin = '0';
  }
  wrap.style.flex = '0 0 auto';
  sizeOverlay();
  return vp;
}

// The overlay canvas is viewport-sized, never document-sized: at deep zoom on a
// 12000px document the backing store would otherwise exceed the browser limit.
function sizeOverlay() {
  const ov = $('#overlay');
  const viewer = $('#viewer');
  if (!ov || !viewer) return null;
  const w = Math.max(1, viewer.clientWidth);
  const h = Math.max(1, viewer.clientHeight);
  if (ov.width !== w) ov.width = w;
  if (ov.height !== h) ov.height = h;
  ov.style.width = w + 'px';
  ov.style.height = h + 'px';
  return { ov, g: ov.getContext('2d'), w, h };
}

// Document rect currently visible inside the scroll container.
function visibleDocRect() {
  const stage = $('#stage');
  const vp = viewportRect();
  if (vp.fit) return { x: 0, y: 0, w: docSize().w, h: docSize().h };
  const { w: docW, h: docH } = docSize();
  const pad = 32;
  const x0 = Math.max(0, Math.floor((stage.scrollLeft - pad) / vp.sx));
  const y0 = Math.max(0, Math.floor((stage.scrollTop - pad) / vp.sy));
  const x1 = Math.min(docW, Math.ceil((stage.scrollLeft + stage.clientWidth + pad) / vp.sx));
  const y1 = Math.min(docH, Math.ceil((stage.scrollTop + stage.clientHeight + pad) / vp.sy));
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
}

let viewToken = 0;
async function refreshView(force) {
  if (!state.record) return;
  const vp = layoutWrap();
  const token = ++viewToken;
  const img = $('#poster');
  const { w: docW, h: docH } = docSize();
  let url, crop = null;

  if (vp.fit) {
    const ow = Math.min(1600, vp.w);
    const key = state.record.jobId + ':overview:' + ow;
    if (!force && state.viewKey === key) { renderOverlay(); return; }
    state.viewKey = key;
    url = `/api/runs/${state.record.jobId}/overview.png?w=${ow}`;
    img.style.left = '0'; img.style.top = '0';
    img.style.width = vp.w + 'px'; img.style.height = vp.h + 'px';
  } else {
    const vis = visibleDocRect();
    const maxCrop = 1536;
    crop = { x: vis.x, y: vis.y, w: Math.min(maxCrop, vis.w), h: Math.min(maxCrop, vis.h) };
    const key = `${state.record.jobId}:${crop.x}:${crop.y}:${crop.w}:${crop.h}`;
    if (!force && state.viewKey === key) { renderOverlay(); return; }
    state.viewKey = key;
    url = `/api/runs/${state.record.jobId}/crop.png?x=${crop.x}&y=${crop.y}&w=${crop.w}&h=${crop.h}`;
    // crop image sits at its document offset so seams line up with neighbours
    img.style.left = (crop.x * vp.sx) + 'px';
    img.style.top = (crop.y * vp.sy) + 'px';
    img.style.width = (crop.w * vp.sx) + 'px';
    img.style.height = (crop.h * vp.sy) + 'px';
  }

  const loaded = new Promise(r => { img.onload = r; img.onerror = r; });
  img.src = url;
  await loaded;
  if (token !== viewToken) return;
  renderOverlay();
}

// Document point currently at the centre of the scroll viewport. Computed
// before a zoom change so the buttons keep the same region in view.
function centerDocPoint() {
  const wrap = document.getElementById('posterWrap');
  const stage = $('#stage');
  const { w, h } = docSize();
  if (!wrap) return { x: w / 2, y: h / 2 };
  const vp = viewportRect();
  const wr = wrap.getBoundingClientRect();
  const sr = stage.getBoundingClientRect();
  return {
    x: (sr.left + sr.width / 2 - wr.left) / vp.sx,
    y: (sr.top + sr.height / 2 - wr.top) / vp.sy,
  };
}

async function applyZoomMode(center) {
  if (!state.record) return;
  const stage = $('#stage');
  viewToken++;
  state.viewKey = null;
  const c = center || { x: docSize().w / 2, y: docSize().h / 2 };
  const vp = layoutWrap();
  if (state.zoom !== 'fit') {
    stage.scrollLeft = Math.max(0, c.x * vp.sx - stage.clientWidth / 2);
    stage.scrollTop = Math.max(0, c.y * vp.sy - stage.clientHeight / 2);
  }
  await refreshView(true);
}

async function setZoom(scale) {
  const t = Number(scale) >= 1 ? String(scale) : 'fit';
  const center = state.record ? centerDocPoint() : null;
  state.zoom = t;
  $$('.zoombar button').forEach(x => x.classList.toggle('on', x.dataset.z === t));
  await applyZoomMode(center);
}

function fitScale() {
  const { w, h } = docSize();
  const vw = $('#viewer').clientWidth - 48;
  const vh = $('#viewer').clientHeight - 48;
  return Math.min(vw / w, vh / h, 1);
}

function docCoords(clientX, clientY) {
  const wrap = document.getElementById('posterWrap');
  if (!wrap) return null;
  const r = wrap.getBoundingClientRect();
  const vp = viewportRect();
  return { x: (clientX - r.left) / vp.sx, y: (clientY - r.top) / vp.sy, vp };
}

function bindCanvasEvents(img) {
  img.addEventListener('mousemove', (e) => {
    const d = docCoords(e.clientX, e.clientY);
    if (!d) return;
    const dx = Math.floor(d.x), dy = Math.floor(d.y);
    $('#cursorPos').textContent = `x${dx} y${dy}`;
    const plan = state.plan;
    if (plan && plan.tileList) {
      let hit = null;
      for (const t of plan.tileList) {
        if (dx >= t.crop.x0 && dx < t.crop.x1 && dy >= t.crop.y0 && dy < t.crop.y1) { hit = t; break; }
      }
      if ((hit ? hit.index : null) !== state.hoverTile) {
        state.hoverTile = hit ? hit.index : null;
        renderOverlay();
      }
    }
  });
  // Wheel zooms around the pointer by keeping that document point under it.
  img.addEventListener('wheel', async (e) => {
    if (!state.record) return;
    e.preventDefault();
    const stage = $('#stage');
    const before = docCoords(e.clientX, e.clientY);
    if (!before) return;
    const fit = fitScale();
    const base = state.zoom === 'fit' ? fit : Number(state.zoom);
    const target = Math.max(fit, Math.min(16, base * (e.deltaY < 0 ? 1.25 : 0.8)));
    state.zoom = target <= fit * 1.001 ? 'fit' : String(+target.toFixed(2));
    $$('.zoombar button').forEach(x => x.classList.toggle('on', x.dataset.z === state.zoom));
    viewToken++;
    state.viewKey = null;
    const vp = layoutWrap();
    if (state.zoom !== 'fit') {
      stage.scrollLeft = Math.max(0, before.x * vp.sx - (e.clientX - stage.getBoundingClientRect().left));
      stage.scrollTop = Math.max(0, before.y * vp.sy - (e.clientY - stage.getBoundingClientRect().top));
    }
    await refreshView(true);
  }, { passive: false });
}

function renderOverlay() {
  const wrap = document.getElementById('posterWrap');
  if (!wrap || !state.plan) return;
  const sized = sizeOverlay();
  if (!sized) return;
  const { g, w: ovW, h: ovH } = sized;
  const vp = viewportRect();
  g.clearRect(0, 0, ovW, ovH);

  // Overlay coordinates are viewport pixels: the document box can be much
  // larger than the browser canvas, so translate by the box's on-screen origin
  // (which already includes the scroll offset) instead of using doc coords.
  const wr = wrap.getBoundingClientRect();
  const vr = $('#viewer').getBoundingClientRect();
  const ox = wr.left - vr.left, oy = wr.top - vr.top;
  const scale = vp.sx;
  const plan = state.plan;
  const box = (r) => ({
    x: ox + r.x0 * scale, y: oy + r.y0 * scale,
    w: (r.x1 - r.x0) * scale, h: (r.y1 - r.y0) * scale,
  });
  const visible = (b) =>
    b.x + b.w >= 0 && b.y + b.h >= 0 && b.x <= ovW && b.y <= ovH;
  // At low zoom a dense grid would cover the image itself; only draw tile
  // outlines once a tile is large enough on screen to be read (zoom in to
  // inspect seams and compute ranges).
  const tilePx = plan.tileW * scale;
  if (tilePx >= 40) {
    g.lineWidth = 1;
    if (tilePx >= 72) {
      g.strokeStyle = 'rgba(240,181,61,.4)';
      for (const t of plan.tileList) {
        const b = box(t.contentRect);
        if (!visible(b)) continue;
        g.strokeRect(b.x, b.y, b.w, b.h);
      }
    }
    g.strokeStyle = 'rgba(56,217,181,.65)';
    for (const t of plan.tileList) {
      const b = box(t.crop);
      if (!visible(b)) continue;
      g.strokeRect(b.x, b.y, b.w, b.h);
    }
  } else {
    const { w, h } = docSize();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(56,217,181,.8)';
    g.strokeRect(ox + 0.5, oy + 0.5, w * scale - 1, h * scale - 1);
  }
  if (state.hoverTile != null) {
    const t = plan.tileList.find(x => x.index === state.hoverTile);
    if (t) {
      const b = box(t.crop);
      g.strokeStyle = 'rgba(150,200,255,.95)';
      g.lineWidth = 2;
      g.strokeRect(b.x, b.y, b.w, b.h);
    }
  }
  if (state.selected != null) {
    const t = plan.tileList.find(x => x.index === state.selected);
    if (t) {
      const b = box(t.crop);
      g.strokeStyle = 'rgba(255,107,107,1)';
      g.lineWidth = 2.5;
      g.strokeRect(b.x, b.y, b.w, b.h);
      g.setLineDash([6, 4]);
      g.strokeStyle = 'rgba(255,170,120,.95)';
      const c = box(t.contentRect);
      g.strokeRect(c.x, c.y, c.w, c.h);
      g.setLineDash([]);
    }
  }
}

// ---------------------------------------------------------------- errors
function setStatus(kind, text) {
  const d = $('#dot');
  d.className = 'dot' + (kind ? ' ' + kind : '');
  $('#statusText').textContent = text;
}
function showError(msg) {
  const box = $('#errorBox');
  box.textContent = String(msg);
  box.classList.remove('hidden');
  setStatus('bad', '出错');
  console.error(msg);
}
function clearError() { $('#errorBox').classList.add('hidden'); }

const howto = $('#howto');
howto.onclick = (e) => {
  e.preventDefault();
  const m = document.createElement('div');
  m.className = 'modal';
  m.innerHTML = `<div class="card">
    <h2>怎样启动分块滤镜</h2>
    <p>界面不是静态预览，它由内核驱动：控件来自 <code>/api/kernel</code>，提交任务后由子进程节点渲染，结果来自磁盘块缓存。</p>
    <ol>
      <li>在项目根目录安装依赖（首次）：<code>npm install</code></li>
      <li>启动任务面板：<code>npm start</code></li>
      <li>浏览器打开<code>http://127.0.0.1:4173</code></li>
    </ol>
    <p>环境变量：<code>PORT</code> 改端口，<code>WORKERS</code> 改工作节点数。</p>
    <p>面板会显示预演网格；点“提交出图”后，顶部进度、结果区大图、每块计算范围与边界差值会实时更新。失败会回显在“事件”和红框中。</p>
    <button id="mclose">关闭</button>
  </div>`;
  document.body.append(m);
  m.querySelector('#mclose').onclick = () => m.remove();
  m.onclick = (ev) => { if (ev.target === m) m.remove(); };
};

boot();
