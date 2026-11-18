'use strict';
// HTTP + SSE server for the tiled-filter job panel.
// Kernel drives every control: the UI fetches /api/kernel to build sliders and
// the scene catalogue, then posts jobs. All failures flow back to the panel.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { Scheduler, TILE_CACHE, PATCH_DIR } = require('../kernel/scheduler');
const { FILTERS, normalizeChain } = require('../kernel/filters');
const { SCENE_BUILDERS } = require('../kernel/scene');
const { planTiles, renderReference, compareToReference, cfgHash, summarizePlan } = require('../kernel/pipeline');
const { preloadSprites, ASSETS, PatchCache, setPatchCache } = require('../kernel/scene');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = path.join(__dirname, '..', '..');
const UI = path.join(__dirname, '..', 'ui');
const MAX_BODY = 256 * 1024;

const scheduler = new Scheduler({ workers: Number(process.env.WORKERS || 0) || undefined });
const runs = new Map(); // jobId -> { run, export, ref, cmp, seam }
let seq = 0;

const SCENES = [
  { id: 'grid', label: 'SUPERSCALE（网点 + 轨道）', note: '高对比网点，最容易暴露分块接缝' },
  { id: 'aurora', label: 'AURORA（柔光 + 星形）', note: '大范围柔光与渐变，检查模糊截断' },
  { id: 'boundary', label: '边界素材（细线 + 透明边缘 + 大半径）', note: '1–2px 细线、渐隐透明边、大半径柔光，四周透明外缘' },
];

// Demo packs archived under demo/: the panel loads their source parameters
// straight from each manifest, so the pack is a runnable resource, not a
// screenshot. Scanning is cheap (small JSON files) and always current.
function demoPacks() {
  const dir = path.join(ROOT, 'demo');
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  for (const name of names) {
    const file = path.join(dir, name, 'manifest.json');
    try {
      const m = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!m.source || !m.filters) continue;
      out.push({
        id: m.pack, label: m.label, dir: 'demo/' + name,
        scene: m.source.scene, width: m.source.width, height: m.source.height,
        filters: m.filters, tileSizes: m.tileSizes,
        validRegion: m.validRegion, maxHalo: m.neighborhood && m.neighborhood.maxHalo,
        checks: m.checks,
      });
    } catch (_) { /* a broken manifest must not break the panel */ }
  }
  return out;
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (_) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function kernelDescriptor() {
  return {
    version: require('../kernel/pipeline').KERNEL_VERSION,
    filters: Object.entries(FILTERS).map(([type, f]) => ({
      type, label: f.label, description: f.description,
      params: Object.entries(f.params).map(([key, p]) => ({ key, ...p })),
    })),
    scenes: SCENES,
    demoPacks: demoPacks(),
    limits: {
      maxTiles: require('../kernel/pipeline').MAX_TILES,
      minTile: 16, maxTile: 8192,
      defaultWorkers: scheduler.workers,
    },
    patch: { cell: require('../kernel/elements').PATCH, edgePad: require('../kernel/elements').EDGE_PAD },
  };
}

function validateJob(body) {
  const scene = String(body.scene || '');
  if (!SCENE_BUILDERS[scene]) throw new Error('未知场景');
  const width = Math.round(Number(body.width));
  const height = Math.round(Number(body.height));
  if (!(width >= 64 && width <= 24000)) throw new Error('宽度需在 64–24000 之间');
  if (!(height >= 64 && height <= 24000)) throw new Error('高度需在 64–24000 之间');
  const tileW = Math.round(Number(body.tileW));
  const tileH = Math.round(Number(body.tileH || body.tileW));
  if (!(tileW >= 16 && tileW <= 8192 && tileH >= 16 && tileH <= 8192)) throw new Error('分块尺寸需在 16–8192 之间');
  if (width * height > 400e6) throw new Error('总像素超过 4 亿上限');
  const filters = Array.isArray(body.filters) ? body.filters : [];
  if (filters.length > 6) throw new Error('滤镜最多 6 个');
  normalizeChain(filters, width, height); // throws on bad params/colors
  return {
    scene, width, height, tileW, tileH, filters,
    failInject: Array.isArray(body.failInject) ? body.failInject.map(Number).filter(Number.isFinite) : [],
  };
}

async function handleRun(req, res) {
  let job;
  try { job = validateJob(await readBody(req)); }
  catch (err) { return json(res, 400, { error: String(err.message) }); }

  const jobId = 'run' + (++seq);
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const send = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('accepted', { jobId, job: { ...job, filters: undefined } });

  const t0 = Date.now();
  let run;
  try {
    run = await scheduler.run(job, {
      onPlan: (plan, st) => send('plan', { plan, cache: st }),
      onTile: e => send('tile', e),
      onRetry: e => send('retry', e),
    });
  } catch (err) {
    send('error', { message: String(err.message), stack: String(err.stack || '') });
    res.end();
    return;
  }

  if (!run.ok) {
    send('failed', { failures: run.failures, events: run.events, stats: run.stats, jobId });
    res.end();
    return;
  }

  let exported;
  try { exported = await scheduler.exportRun(run); }
  catch (err) {
    send('error', { message: '导出失败: ' + err.message });
    res.end();
    return;
  }

  // Reference comparison: only for small documents, stays inside a hard pixel cap.
  let reference = null;
  let referencePng = null;
  let referencePixels = null;
  if (job.width * job.height <= 6e6) {
    try {
      const built = await buildReference(job, run);
      referencePng = built.png;
      referencePixels = { data: built.pixels, rect: built.rect };
      reference = built.summary;
    } catch (err) {
      reference = { error: String(err.message) };
    }
  }

  const record = {
    jobId, job, plan: summarizePlan(run.plan), stats: run.stats, events: run.events,
    export: { width: exported.width, height: exported.height, bytes: exported.bytes, peakMb: exported.peakMb, url: `/api/runs/${jobId}/poster.png` },
    reference, cfgKey: run.cfgKey, jobDir: run.jobDir,
    memory: {
      nodePeakMb: run.stats.peakNodeMb,
      nodeLimitMb: run.stats.memoryLimitMb,
      exportStripPeakMb: exported.peakMb,
      payloadLimitMb: scheduler.payloadLimitMb,
      coordinatorRssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
    },
    tiles: run.plan.tiles.map(t => ({
      index: t.index, row: t.row, col: t.col,
      crop: t.crop, contentRect: t.contentRect, halo: t.halo,
      extraRatio: +t.extraRatio.toFixed(3),
      ms: run.tileMs[t.index] || null,
    })),
    cache: { reused: run.stats.cachedTiles, rendered: run.stats.renderedTiles, retried: run.stats.retriedTiles },
  };
  runs.set(jobId, { record, run, exported, referencePng, referencePixels });
  send('done', record);
  res.end();
}

async function buildReference(job, run) {
  // In-process whole-canvas render, explicitly capped for memory.
  const scene = SCENE_BUILDERS[job.scene](job.width, job.height);
  const pc = new PatchCache(PATCH_DIR, 16);
  setPatchCache(pc);
  const filters = normalizeChain(job.filters, job.width, job.height);
  const ref = renderReference(scene, filters);
  const cmp = compareToReference(run.plan.tiles, (i) => fs.readFileSync(path.join(run.jobDir, 'tiles', i + '.bin')), ref.data, ref.rect);

  // Boundary difference against the reference: per-tile edge band (2px) error,
  // which is what the panel draws as heat and highlights on zoom.
  const W = job.width, H = job.height;
  const edgePixels = [];
  for (const t of run.plan.tiles) {
    const buf = fs.readFileSync(path.join(run.jobDir, 'tiles', t.index + '.bin'));
    const w = t.crop.x1 - t.crop.x0, h = t.crop.y1 - t.crop.y0;
    let eMax = 0, eSum = 0, eN = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const onEdge = x < 2 || y < 2 || x >= w - 2 || y >= h - 2;
        if (!onEdge) continue;
        const ai = (y * w + x) * 4;
        const bi = ((t.crop.y0 + y) * W + (t.crop.x0 + x)) * 4;
        let d = 0;
        for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(buf[ai + c] - ref.data[bi + c]));
        eMax = Math.max(eMax, d); eSum += d; eN++;
      }
    }
    edgePixels.push({ index: t.index, maxDiff: eMax, meanDiff: eN ? +(eSum / eN).toFixed(4) : 0 });
  }
  return {
    summary: {
      maxDiff: cmp.maxDiff, meanDiff: cmp.meanDiff, pixels: cmp.pixels, worst: cmp.worst,
      edge: {
        maxDiff: edgePixels.reduce((m, e) => Math.max(m, e.maxDiff), 0),
        meanDiff: +(edgePixels.reduce((s, e) => s + e.meanDiff, 0) / Math.max(1, edgePixels.length)).toFixed(4),
        perTile: edgePixels,
      },
      perTile: cmp.perTile,
      width: W, height: H,
    },
    png: require('../kernel/png').encodePng(W, H, ref.data),
    pixels: ref.data,
    rect: ref.rect,
  };
}

function findRun(jobId) {
  const r = runs.get(jobId);
  if (!r) return null;
  return r;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const file = path.join(UI, 'index.html');
    const buf = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(buf);
  }
  if (req.method === 'GET' && p.startsWith('/ui/')) {
    const rel = p.slice('/ui/'.length);
    if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
    const file = path.join(UI, rel);
    if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
    const ext = path.extname(file);
    const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type + '; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(fs.readFileSync(file));
  }
  if (req.method === 'GET' && p === '/api/kernel') return json(res, 200, kernelDescriptor());

  if (req.method === 'POST' && p === '/api/run') return handleRun(req, res);

  if (req.method === 'POST' && p === '/api/preview') {
    // Plan-only preview: returns grid, per-tile compute rects and halos.
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: err.message }); }
    try {
      const job = validateJob(body);
      const scene = SCENE_BUILDERS[job.scene](job.width, job.height);
      const plan = planTiles(scene, job);
      const filters = normalizeChain(job.filters, job.width, job.height);
      return json(res, 200, {
        plan: summarizePlan(plan),
        scene: { id: scene.id, width: scene.width, height: scene.height, elements: scene.elements.map((e, i) => ({ i, type: e.type, id: e.id })) },
        filters: plan.filters.map(({ type, sigma, spread, dx, dy, scale, angle, cx, cy, color, opacity }) => ({ type, sigma, spread, dx, dy, scale, angle, cx, cy, color, opacity })),
      });
    } catch (err) { return json(res, 400, { error: String(err.message) }); }
  }

  if (req.method === 'POST' && p === '/api/grids') {
    // Cross-grid edge-error comparison: same document and filters, several
    // tile sizes, each compared against the whole-image reference.
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: err.message }); }
    try {
      const scene0 = String(body.scene || 'grid');
      if (!SCENE_BUILDERS[scene0]) throw new Error('未知场景');
      const width = Math.round(Number(body.width)), height = Math.round(Number(body.height));
      if (!(width >= 64 && width <= 4096 && height >= 64 && height <= 4096)) throw new Error('跨网格对照仅支持 64–4096 的参照画幅');
      const filters = Array.isArray(body.filters) ? body.filters : [];
      if (filters.length > 6) throw new Error('滤镜最多 6 个');
      normalizeChain(filters, width, height);
      const sizes = (Array.isArray(body.tileSizes) ? body.tileSizes : [64, 128, 256, 512])
        .map(Number).filter(n => Number.isFinite(n) && n >= 16 && n <= 2048)
        .slice(0, 6);
      if (!sizes.length) throw new Error('至少给出一个分块尺寸');
      const scene = SCENE_BUILDERS[scene0](width, height);
      await preloadSprites(ASSETS);
      const pc = new PatchCache(PATCH_DIR, 24);
      setPatchCache(pc);
      const cmp = require('../kernel/pipeline').crossGridCompare(scene, filters, sizes);
      return json(res, 200, cmp);
    } catch (err) { return json(res, 400, { error: String(err.message) }); }
  }

  let m = /^\/api\/runs\/([^/]+)\/(poster|reference)\.png$/.exec(p);
  if (req.method === 'GET' && m) {
    const r = findRun(m[1]);
    if (!r) return json(res, 404, { error: 'unknown run' });
    if (m[2] === 'poster') {
      const file = r.record.jobDir ? path.join(r.record.jobDir, 'poster.png') : null;
      if (!file || !fs.existsSync(file)) return json(res, 404, { error: 'no poster' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': fs.statSync(file).size });
      return fs.createReadStream(file).pipe(res);
    }
    if (m[2] === 'reference') {
      if (!r.referencePng) return json(res, 404, { error: 'no reference for this run' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(r.referencePng);
    }
  }

  // Reference crop for side-by-side inspection: same document rect as the
  // poster crop, so the two images can be compared pixel for pixel.
  m = /^\/api\/runs\/([^/]+)\/refcrop\.png$/.exec(p);
  if (req.method === 'GET' && m) {
    const r = findRun(m[1]);
    if (!r || !r.referencePixels) return json(res, 404, { error: 'no reference for this run' });
    const x = Math.max(0, Math.round(Number(url.searchParams.get('x'))));
    const y = Math.max(0, Math.round(Number(url.searchParams.get('y'))));
    const w = Math.max(1, Math.min(2048, Math.round(Number(url.searchParams.get('w')) || 256)));
    const h = Math.max(1, Math.min(2048, Math.round(Number(url.searchParams.get('h')) || 256)));
    const src = r.referencePixels;
    const cw = Math.min(w, src.rect.x1 - src.rect.x0 - x), ch = Math.min(h, src.rect.y1 - src.rect.y0 - y);
    if (cw <= 0 || ch <= 0) return json(res, 400, { error: 'crop out of bounds' });
    const out = Buffer.allocUnsafe(cw * ch * 4);
    const rw = src.rect.x1 - src.rect.x0;
    for (let j = 0; j < ch; j++) {
      const s = ((y + j) * rw + x) * 4;
      src.data.copy(out, j * cw * 4, s, s + cw * 4);
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    return res.end(require('../kernel/png').encodePng(cw, ch, out));
  }

  m = /^\/api\/runs\/([^/]+)\/tile\/(\d+)\.png$/.exec(p);
  if (req.method === 'GET' && m) {
    const r = findRun(m[1]);
    if (!r) return json(res, 404, { error: 'unknown run' });
    const idx = Number(m[2]);
    const t = r.run.plan.tiles[idx];
    if (!t) return json(res, 404, { error: 'unknown tile' });
    // Encode one tile crop with a small border strip of its compute rect for
    // the "actual compute range" overlay. Encoded on demand, never held.
    const buf = fs.readFileSync(path.join(r.record.jobDir, 'tiles', idx + '.bin'));
    const w = t.crop.x1 - t.crop.x0, h = t.crop.y1 - t.crop.y0;
    const { encodePng } = require('../kernel/png');
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
    return res.end(encodePng(w, h, buf));
  }

  m = /^\/api\/runs\/([^/]+)\/crop\.png$/.exec(p);
  if (req.method === 'GET' && m) {
    // Zoomed crop straight from the tile files, never from a decoded poster.
    const r = findRun(m[1]);
    if (!r) return json(res, 404, { error: 'unknown run' });
    const x = Math.max(0, Math.round(Number(url.searchParams.get('x'))));
    const y = Math.max(0, Math.round(Number(url.searchParams.get('y'))));
    const w = Math.max(1, Math.min(2048, Math.round(Number(url.searchParams.get('w')) || 256)));
    const h = Math.max(1, Math.min(2048, Math.round(Number(url.searchParams.get('h')) || 256)));
    try {
      const out = cropFromTiles(r, x, y, w, h);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(require('../kernel/png').encodePng(Math.min(w, r.record.export.width - x), Math.min(h, r.record.export.height - y), out));
    } catch (err) { return json(res, 500, { error: String(err.message) }); }
  }

  m = /^\/api\/runs\/([^/]+)\/overview\.png$/.exec(p);
  if (req.method === 'GET' && m) {
    const r = findRun(m[1]);
    if (!r) return json(res, 404, { error: 'unknown run' });
    const maxW = Math.max(64, Math.min(2048, Math.round(Number(url.searchParams.get('w')) || 1024)));
    try {
      const ov = overviewFromTiles(r, maxW);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(ov.png);
    } catch (err) { return json(res, 500, { error: String(err.message) }); }
  }

  if (req.method === 'GET' && p === '/api/runs') {
    return json(res, 200, {
      runs: [...runs.values()].map(r => ({
        jobId: r.record.jobId, scene: r.record.job.scene,
        width: r.record.job.width, height: r.record.job.height,
        tileW: r.record.job.tileW, tiles: r.record.plan.tiles,
        stats: r.record.stats, memory: r.record.memory,
        reference: r.record.reference ? { maxDiff: r.record.reference.maxDiff, meanDiff: r.record.reference.meanDiff, edge: r.record.reference.edge } : null,
      })),
    });
  }

  return json(res, 404, { error: 'not found' });
}

// Crop the assembled document straight from the tile files. The coordinator
// never decodes the whole poster: only the requested rect's tiles are read.
function cropFromTiles(r, x, y, w, h) {
  const W = r.record.export.width, H = r.record.export.height;
  const cw = Math.min(w, W - x), ch = Math.min(h, H - y);
  if (cw <= 0 || ch <= 0) throw new Error('crop out of bounds');
  const out = Buffer.allocUnsafe(cw * ch * 4);
  const want = { x0: x, y0: y, x1: x + cw, y1: y + ch };
  for (const t of r.run.plan.tiles) {
    const ix0 = Math.max(t.crop.x0, want.x0), iy0 = Math.max(t.crop.y0, want.y0);
    const ix1 = Math.min(t.crop.x1, want.x1), iy1 = Math.min(t.crop.y1, want.y1);
    if (ix1 <= ix0 || iy1 <= iy0) continue;
    const tw = t.crop.x1 - t.crop.x0;
    const buf = fs.readFileSync(path.join(r.record.jobDir, 'tiles', t.index + '.bin'));
    for (let yy = iy0; yy < iy1; yy++) {
      const src = ((yy - t.crop.y0) * tw + (ix0 - t.crop.x0)) * 4;
      const dst = ((yy - y) * cw + (ix0 - x)) * 4;
      buf.copy(out, dst, src, src + (ix1 - ix0) * 4);
    }
  }
  return out;
}

// Downscaled overview for the viewer. Nearest sampling, one tile buffer at a
// time; peak memory is the overview buffer, not the document.
function overviewFromTiles(r, maxW) {
  const W = r.record.export.width, H = r.record.export.height;
  const ow = Math.min(maxW, W);
  const oh = Math.max(1, Math.round(H * ow / W));
  const out = Buffer.allocUnsafe(ow * oh * 4);
  const sx = W / ow, sy = H / oh;
  for (const t of r.run.plan.tiles) {
    const tw = t.crop.x1 - t.crop.x0;
    const ox0 = Math.max(0, Math.floor(t.crop.x0 / sx)), ox1 = Math.min(ow, Math.ceil(t.crop.x1 / sx));
    const oy0 = Math.max(0, Math.floor(t.crop.y0 / sy)), oy1 = Math.min(oh, Math.ceil(t.crop.y1 / sy));
    if (ox1 <= ox0 || oy1 <= oy0) continue;
    const buf = fs.readFileSync(path.join(r.record.jobDir, 'tiles', t.index + '.bin'));
    for (let oy = oy0; oy < oy1; oy++) {
      const dY = Math.min(H - 1, Math.floor((oy + 0.5) * sy));
      const rY = Math.min(t.crop.y1 - 1, Math.max(t.crop.y0, dY)) - t.crop.y0;
      for (let ox = ox0; ox < ox1; ox++) {
        const dX = Math.min(W - 1, Math.floor((ox + 0.5) * sx));
        if (dX < t.crop.x0 || dX >= t.crop.x1 || dY < t.crop.y0 || dY >= t.crop.y1) continue;
        const si = (rY * tw + (dX - t.crop.x0)) * 4;
        const di = (oy * ow + ox) * 4;
        out[di] = buf[si]; out[di + 1] = buf[si + 1]; out[di + 2] = buf[si + 2]; out[di + 3] = buf[si + 3];
      }
    }
  }
  return { png: require('../kernel/png').encodePng(ow, oh, out), width: ow, height: oh };
}

(async () => {
  await scheduler.prepare();
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (!res.headersSent) json(res, 500, { error: String(err.message) });
      else res.end();
    });
  });
  server.listen(PORT, HOST, () => {
    console.log(`MEGAPOSTER 分块滤镜面板: http://${HOST}:${PORT}`);
    console.log(`工作节点: ${scheduler.workers}  缓存: ${TILE_CACHE}`);
  });
  const shutdown = () => { try { scheduler.shutdown && scheduler.shutdown(); } catch (_) {} server.close(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
