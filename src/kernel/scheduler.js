'use strict';
// Job scheduler: worker processes, retry-on-failure (only missing tiles are
// re-queued), disk tile cache keyed by inputs+effects, and streaming export.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { fork } = require('child_process');
const { planTiles, processTile, cfgHash, renderReference, compareToReference, summarizePlan } = require('./pipeline');
const { PngWriter } = require('./png');
const { SCENE_BUILDERS, PatchCache, preloadSprites, ASSETS } = require('./scene');
const { hashOf } = require('./hash');

const WORKER = path.join(__dirname, 'worker.js');
const ROOT = path.join(__dirname, '..', '..');
const TILE_CACHE = path.join(ROOT, '.cache', 'tiles');
const PATCH_DIR = path.join(ROOT, '.cache', 'patches');

class Scheduler {
  constructor(opts = {}) {
    this.workers = opts.workers || Math.max(2, Math.min(6, Math.floor(os.cpus().length / 2)));
    this.retries = opts.retries == null ? 2 : opts.retries;
    this.memoryLimitMb = opts.memoryLimitMb || 256;
    this.payloadLimitMb = opts.payloadLimitMb || 512;
    this.cacheDir = opts.cacheDir || TILE_CACHE;
    this.patchDir = opts.patchDir || PATCH_DIR;
  }

  async prepare() {
    await preloadSprites(ASSETS);
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.mkdirSync(this.patchDir, { recursive: true });
  }

  spawn(jobDir) {
    // The memory budget is enforced, not just reported: a runaway tile (e.g. a
    // huge halo) dies as a node failure and is retried like any other error,
    // instead of pushing the machine into swap.
    const child = fork(WORKER, [], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      resourceLimits: {
        maxOldGenerationSizeMb: this.memoryLimitMb,
        maxYoungGenerationSizeMb: Math.max(16, Math.min(64, Math.round(this.memoryLimitMb / 8))),
      },
    });
    const w = { child, jobDir, busy: false, pending: null, seq: 0, peakMb: 0, killed: false, failCount: 0 };
    child.on('message', (msg) => {
      if (msg.event === 'fatal') {
        if (w.pending) { const p = w.pending; w.pending = null; p.reject(new Error('节点异常: ' + msg.error)); }
        return;
      }
      if (!w.pending || msg.id !== w.pending.id) return;
      const p = w.pending; w.pending = null; w.busy = false;
      if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || '节点错误'));
    });
    child.on('exit', (code, signal) => {
      w.killed = true;
      if (w.pending) {
        const p = w.pending; w.pending = null;
        p.reject(new Error(`节点退出 (code=${code}${signal ? ' signal=' + signal : ''})`));
      }
    });
    return w;
  }

  call(w, msg, timeoutMs = 900000) {
    return new Promise((resolve, reject) => {
      if (w.killed) { reject(new Error('节点已退出')); return; }
      const id = ++w.seq;
      w.busy = true;
      const timer = setTimeout(() => {
        if (w.pending && w.pending.id === id) {
          w.pending = null;
          try { w.child.kill('SIGKILL'); } catch (_) {}
          reject(new Error('节点超时'));
        }
      }, timeoutMs);
      w.pending = {
        id,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      try {
        w.child.send({ ...msg, id, jobDir: w.jobDir, patchDir: this.patchDir });
      } catch (err) {
        w.pending = null;
        clearTimeout(timer);
        reject(new Error('节点 IPC 已关闭: ' + err.message));
      }
    });
  }

  async run(job, hooks = {}) {
    await this.prepare();
    const sceneId = job.scene;
    if (!SCENE_BUILDERS[sceneId]) throw new Error('未知场景: ' + sceneId);
    const scene = SCENE_BUILDERS[sceneId](job.width, job.height);
    const plan = planTiles(scene, job);
    const cfgKey = cfgHash(job, scene);
    const jobId = hashOf({ cfgKey, tiles: plan.tiles.length }, 10);
    const jobDir = path.join(this.cacheDir, 'job-' + jobId);
    fs.mkdirSync(path.join(jobDir, 'tiles'), { recursive: true });
    fs.writeFileSync(path.join(jobDir, 'meta.json'), JSON.stringify({
      scene: scene.id, docW: scene.width, docH: scene.height,
      cfg: { tileW: job.tileW, tileH: job.tileH, filters: job.filters, content: job.content || 'full' },
      memoryLimitMb: this.memoryLimitMb,
    }));

    const total = plan.tiles.length;
    const done = new Set();
    const cached = new Set();
    const attempts = new Map();
    const events = [];
    const tileMs = new Map();
    const workerPeaks = [];
    const t0 = Date.now();

    // ---- disk cache reuse: only the coordinator decides what is missing ----
    const missing = [];
    for (const t of plan.tiles) {
      const f = path.join(jobDir, 'tiles', t.index + '.bin');
      if (fs.existsSync(f) && fs.statSync(f).size === (t.crop.x1 - t.crop.x0) * (t.crop.y1 - t.crop.y0) * 4) {
        done.add(t.index); cached.add(t.index);
      } else {
        missing.push(t.index);
      }
    }
    if (hooks.onPlan) hooks.onPlan(summarizePlan(plan), { cached: cached.size, missing: missing.length, total });

    // ---- workers ----
    const pool = [];
    const workerCount = Math.max(1, Math.min(this.workers, Math.max(1, missing.length)));
    for (let i = 0; i < workerCount; i++) {
      const w = this.spawn(jobDir);
      pool.push(w);
      try { await this.call(w, { type: 'warmup' }, 180000); } catch (e) { /* warmup failure shows per tile */ }
    }

    const queue = [...missing];
    const failures = [];
    let peakNodeMb = 0;
    let finished = 0;

    const runTile = async (w, index) => {
      const started = Date.now();
      try {
        if (job.failInject && job.failInject.includes(index) && !attempts.has(index)) {
          throw new Error('模拟节点故障');
        }
        const res = await this.call(w, { type: 'tile', index });
        attempts.set(index, (attempts.get(index) || 0) + 1);
        done.add(index);
        tileMs.set(index, res.ms);
        peakNodeMb = Math.max(peakNodeMb, res.peakRssMb || 0);
        workerPeaks.push({ pid: w.child.pid, tile: index, peakRssMb: res.peakRssMb, ms: res.ms });
        finished++;
        if (hooks.onTile) hooks.onTile({ index, ms: res.ms, done: done.size, total, cached: cached.has(index), peakRssMb: res.peakRssMb });
        return null;
      } catch (err) {
        const n = attempts.get(index) || 0;
        attempts.set(index, n + 1);
        const overBudget = /内存上限/.test(String(err.message));
        let replacement = null;
        if (w.killed || overBudget) {
          // Replace the node and keep the rest of the pool. A node over the
          // memory budget can never pass again (VmHWM is monotonic), so it is
          // discarded like a dead one.
          const i = pool.indexOf(w);
          if (i >= 0) pool.splice(i, 1);
          if (!w.killed) { try { w.child.kill('SIGKILL'); } catch (_) {} w.killed = true; }
          replacement = this.spawn(jobDir);
          pool.push(replacement);
          try { await this.call(replacement, { type: 'warmup' }, 180000); } catch (_) {}
        }
        if (n < this.retries) {
          events.push({ tile: index, attempt: n + 1, kind: 'retry', error: String(err.message), atMs: Date.now() - t0 });
          queue.push(index);
          if (hooks.onRetry) hooks.onRetry({ index, attempt: n + 1, error: String(err.message) });
        } else {
          failures.push({ index, error: String(err.message) });
          events.push({ tile: index, attempt: n + 1, kind: 'failed', error: String(err.message), atMs: Date.now() - t0 });
        }
        return replacement;
      }
    };

    // one queue, one persistent worker per slot
    await new Promise((resolve) => {
      const idle = [...pool];
      let active = 0;
      const pump = () => {
        while (idle.length && queue.length) {
          const index = queue.shift();
          const w = idle.pop();
          active++;
          runTile(w, index).then((replacement) => {
            active--;
            if (replacement) idle.push(replacement);
            else if (!w.killed) idle.push(w);
            if (!queue.length && active === 0) resolve(); else pump();
          });
        }
        if (!queue.length && active === 0) resolve();
      };
      pump();
    });

    for (const w of pool) { try { w.child.kill('SIGKILL'); } catch (_) {} }

    // Peak RSS is a property of the job, not of this invocation: when every
    // tile is a cache hit no worker runs, so report the recorded historical
    // peak instead of zero.
    const peakFile = path.join(jobDir, 'peak.json');
    let recordedPeak = 0;
    try { recordedPeak = JSON.parse(fs.readFileSync(peakFile, 'utf8')).peakNodeMb || 0; } catch (_) {}
    const runPeak = peakNodeMb;
    if (peakNodeMb > recordedPeak) {
      fs.writeFileSync(peakFile, JSON.stringify({ peakNodeMb: +peakNodeMb.toFixed(1), at: new Date().toISOString() }));
    } else {
      peakNodeMb = recordedPeak;
    }

    const stats = {
      ...summarizePlan(plan),
      total, cachedTiles: cached.size, renderedTiles: done.size - cached.size,
      retriedTiles: events.filter(e => e.kind === 'retry').length,
      failedTiles: failures.length,
      wallMs: Date.now() - t0,
      peakNodeMb: +peakNodeMb.toFixed(1),
      peakNodeFromCache: runPeak === 0 && peakNodeMb > 0,
      memoryLimitMb: this.memoryLimitMb,
    };
    return {
      ok: failures.length === 0,
      jobId, jobDir, cfgKey, plan, stats, events, failures,
      tileMs: Object.fromEntries(tileMs),
      workerPeaks,
      cached: [...cached],
    };
  }

  // Export: read each tile row-wise, assemble one strip at a time, stream PNG.
  exportRun(run) {
    const plan = run.plan;
    const W = plan.docRect.x1, H = plan.docRect.y1;
    const outFile = path.join(run.jobDir, 'poster.png');
    const writer = new PngWriter(outFile, W, H, { level: 6 });
    const byRow = new Map();
    for (const t of plan.tiles) {
      if (!byRow.has(t.row)) byRow.set(t.row, []);
      byRow.get(t.row).push(t);
    }
    let peakMb = 0;
    for (let r = 0; r < plan.rows; r++) {
      const rowTiles = byRow.get(r).sort((a, b) => a.col - b.col);
      const rh = rowTiles[0].crop.y1 - rowTiles[0].crop.y0;
      const strip = Buffer.allocUnsafe(W * rh * 4);
      for (const t of rowTiles) {
        const buf = fs.readFileSync(path.join(run.jobDir, 'tiles', t.index + '.bin'));
        const w = t.crop.x1 - t.crop.x0, h = t.crop.y1 - t.crop.y0;
        for (let y = 0; y < h; y++) {
          buf.copy(strip, ((y * W) + t.crop.x0) * 4, y * w * 4, (y + 1) * w * 4);
        }
        peakMb = Math.max(peakMb, (strip.length + buf.length) / 1048576);
      }
      writer.write(strip);
    }
    writer.end();
    const bytes = fs.statSync(outFile).size;
    return { file: outFile, peakMb: +peakMb.toFixed(1), bytes, width: W, height: H };
  }
}

module.exports = { Scheduler, TILE_CACHE, PATCH_DIR };
