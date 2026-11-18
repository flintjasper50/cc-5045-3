'use strict';
// Scheduler-level tests: retry only re-queues the failed tiles, and cached
// tiles are reused across runs. Runs real worker processes on a tiny document.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Scheduler } = require('../src/kernel/scheduler');

// Isolated cache dirs so tests never collide with the app's real cache.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'megaposter-sched-'));
function makeScheduler(opts = {}) {
  return new Scheduler({
    ...opts,
    cacheDir: path.join(TMP, opts.cacheDir || 'tiles'),
    patchDir: path.join(TMP, 'patches'),
  });
}

const JOB = { scene: 'grid', width: 256, height: 192, tileW: 64, tileH: 64, filters: [{ type: 'blur', sigma: 2 }] };

test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); });

test('a failed tile is retried alone and only rendered blocks are reported', async () => {
  const scheduler = makeScheduler({ workers: 2, retries: 2, cacheDir: 'retry' });
  const job = { ...JOB, tileW: 61, tileH: 61, failInject: [2] };
  const run = await scheduler.run(job);
  assert.strictEqual(run.ok, true, 'run should succeed after retry');
  const retried = run.events.filter(e => e.kind === 'retry');
  assert.deepStrictEqual(retried.map(e => e.tile), [2], 'only the injected tile is retried');
  assert.strictEqual(run.failures.length, 0);
  for (const t of run.plan.tiles) {
    const f = path.join(run.jobDir, 'tiles', t.index + '.bin');
    assert.ok(fs.existsSync(f), `tile ${t.index} written`);
    const w = t.crop.x1 - t.crop.x0, h = t.crop.y1 - t.crop.y0;
    assert.strictEqual(fs.statSync(f).size, w * h * 4, `tile ${t.index} size`);
  }
});

test('a second run reuses every cached tile', async () => {
  const scheduler = makeScheduler({ workers: 2, cacheDir: 'reuse' });
  const first = await scheduler.run(JOB);
  assert.strictEqual(first.stats.cachedTiles, 0);
  const second = await scheduler.run(JOB);
  assert.strictEqual(second.stats.cachedTiles, second.plan.tiles.length, 'all tiles reused');
  assert.strictEqual(second.stats.renderedTiles, 0, 'no tile re-rendered');
  assert.strictEqual(second.jobId, first.jobId, 'same job dir for identical config');
});

test('export streams a full-size PNG whose size matches the document', async () => {
  const scheduler = makeScheduler({ workers: 2, cacheDir: 'export' });
  const run = await scheduler.run(JOB);
  const exported = await scheduler.exportRun(run);
  assert.strictEqual(exported.width, JOB.width);
  assert.strictEqual(exported.height, JOB.height);
  assert.ok(exported.bytes > 100, 'PNG has content');
  const { decodePng } = require('../src/kernel/png');
  const dec = decodePng(fs.readFileSync(exported.file));
  assert.strictEqual(dec.width, JOB.width);
  assert.strictEqual(dec.height, JOB.height);
  // Peak memory while exporting is one strip plus one tile, not the document.
  assert.ok(exported.peakMb < (JOB.width * JOB.height * 4) / 1048576 + 1);
});

test('exported PNG decodes to exactly the assembled tiles, even across flushes', async () => {
  // Bigger than the writer's 1MB flush threshold so several IDAT chunks are
  // emitted: they must be fragments of one zlib stream, not separate streams
  // (a multi-stream file decodes as zeros past the first chunk).
  const scheduler = makeScheduler({ workers: 2, cacheDir: 'export-big' });
  const job = { ...JOB, width: 1024, height: 768, tileW: 128, tileH: 128 };
  const run = await scheduler.run(job);
  const exported = await scheduler.exportRun(run);
  const { decodePng } = require('../src/kernel/png');
  const dec = decodePng(fs.readFileSync(exported.file));
  assert.strictEqual(dec.width, job.width);
  assert.strictEqual(dec.height, job.height);
  for (const t of run.plan.tiles) {
    const buf = fs.readFileSync(path.join(run.jobDir, 'tiles', t.index + '.bin'));
    const w = t.crop.x1 - t.crop.x0, h = t.crop.y1 - t.crop.y0;
    for (let y = 0; y < h; y++) {
      const row = buf.subarray(y * w * 4, (y + 1) * w * 4);
      const off = ((t.crop.y0 + y) * job.width + t.crop.x0) * 4;
      assert.ok(
        dec.data.subarray(off, off + w * 4).equals(row),
        `块 #${t.index} 第 ${y} 行与导出 PNG 不一致`,
      );
    }
  }
});

test('peak node memory is reported even when every tile is cached', async () => {
  const scheduler = makeScheduler({ workers: 2, cacheDir: 'peak' });
  const small = { ...JOB, tileW: 32, tileH: 32 };
  const first = await scheduler.run(small);
  assert.ok(first.stats.peakNodeMb > 0, 'first render records a peak');
  const second = await scheduler.run(small);
  assert.strictEqual(second.stats.renderedTiles, 0);
  assert.ok(second.stats.peakNodeMb > 0, 'cache hits report the recorded peak, not zero');
  assert.strictEqual(second.stats.peakNodeFromCache, true);
});

test('the memory limit is enforced, not just reported', async () => {
  // A budget below the node's own baseline must fail tiles with a memory error
  // instead of letting the node grow. V8's heap cap alone would miss this: the
  // pixel surfaces are ArrayBuffers, invisible to the heap limit.
  const scheduler = makeScheduler({ workers: 1, retries: 0, cacheDir: 'limit', memoryLimitMb: 12 });
  const job = { ...JOB, width: 1024, height: 1024, tileW: 512, tileH: 512, filters: [{ type: 'blur', sigma: 20 }] };
  const run = await scheduler.run(job);
  assert.strictEqual(run.ok, false, 'the run cannot succeed under a 12MB budget');
  assert.ok(run.failures.length > 0, 'at least one node reported a failure');
  const text = run.failures.map(f => String(f.error || f)).join(' ');
  assert.match(text, /内存上限/, `failure names the budget: ${text.slice(0, 200)}`);
});
