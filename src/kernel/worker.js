'use strict';
// Worker node process. Loads the job metadata, rebuilds the scene and tile
// plan, renders strictly the assigned tile, and writes only that tile's crop
// pixels to disk. The coordinator never receives image bytes over IPC.

const fs = require('fs');
const path = require('path');

let job = null;

function statusKb(field) {
  try {
    const s = fs.readFileSync(`/proc/${process.pid}/status`, 'utf8');
    const m = new RegExp(field + ':\\s+(\\d+) kB').exec(s);
    if (m) return Number(m[1]) / 1024;
  } catch (_) {}
  return process.memoryUsage().rss / 1048576;
}

// A tile's working set is several full surfaces (source, blur scratch, mask),
// so the budget is checked against real RSS rather than V8's heap, which never
// sees ArrayBuffer pixels. Peak (VmHWM) is what the UI reports, so it is what
// the budget is compared against: a transient spike counts, not just the
// reading at the end. Exceeding it fails this tile like any other node error.
function enforceMemory() {
  const limit = job && job.meta.memoryLimitMb;
  if (!limit) return;
  const used = statusKb('VmHWM');
  if (used > limit) {
    throw new Error(`节点超出内存上限: 峰值 ${used.toFixed(1)}MB > ${limit}MB`);
  }
}

async function ensureJob(jobDir, patchDir) {
  if (job && job.jobDir === jobDir) return job;
  const meta = JSON.parse(fs.readFileSync(path.join(jobDir, 'meta.json'), 'utf8'));
  const sceneMod = require('./scene');
  await sceneMod.preloadSprites(sceneMod.ASSETS);
  sceneMod.setPatchCache(new sceneMod.PatchCache(patchDir));
  const scene = sceneMod.SCENE_BUILDERS[meta.scene](meta.docW, meta.docH);
  const { planTiles } = require('./pipeline');
  const plan = planTiles(scene, meta.cfg);
  job = { jobDir, meta, scene, plan };
  return job;
}

function peakRssMb() {
  return +statusKb('VmHWM').toFixed(1);
}

async function handle(msg) {
  if (msg.type === 'warmup') {
    const j = await ensureJob(msg.jobDir, msg.patchDir);
    return { ok: true, tiles: j.plan.tiles.length, peakRssMb: peakRssMb() };
  }
  if (msg.type === 'tile') {
    const j = await ensureJob(msg.jobDir, msg.patchDir);
    const tile = j.plan.tiles[msg.index];
    if (!tile) throw new Error('tile index out of range: ' + msg.index);
    const { processTile } = require('./pipeline');
    const t0 = process.hrtime.bigint();
    const buf = processTile(j.scene, j.plan.filters, tile);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // Checked before the tile is committed: an over-budget node must not leave
    // a .bin that the coordinator would later count as a cache hit.
    enforceMemory();
    const file = path.join(j.jobDir, 'tiles', msg.index + '.bin');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);
    return {
      ok: true, index: msg.index, ms: +ms.toFixed(1), bytes: buf.length,
      peakRssMb: peakRssMb(), crop: tile.crop, contentRect: tile.contentRect,
    };
  }
  if (msg.type === 'exit') process.exit(0);
  throw new Error('unknown worker message ' + msg.type);
}

process.on('message', async (msg) => {
  try {
    const res = await handle(msg);
    process.send({ id: msg.id, ...res });
  } catch (err) {
    process.send({ id: msg.id, ok: false, error: String((err && err.stack) || err), index: msg.index });
  }
});
process.on('uncaughtException', (err) => {
  try { process.send({ event: 'fatal', error: String((err && err.stack) || err) }); } catch (_) {}
  process.exit(70);
});
process.on('unhandledRejection', (err) => {
  try { process.send({ event: 'fatal', error: String((err && err.stack) || err) }); } catch (_) {}
  process.exit(71);
});
