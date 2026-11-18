'use strict';
// Benchmark + evidence records for the tiled filter.
//
//   node scripts/bench.js                 small reference sample + cross-grid
//   node scripts/bench.js --large         restricted-memory large export
//
// Everything printed is measured in this process; nothing is illustrative.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Scheduler } = require('../src/kernel/scheduler');
const { SCENE_BUILDERS, preloadSprites, ASSETS, setPatchCache, PatchCache } = require('../src/kernel/scene');
const { crossGridCompare } = require('../src/kernel/pipeline');
const { PATCH_DIR } = require('../src/kernel/scheduler');

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const CHAIN = [
  { type: 'blur', sigma: 6 },
  { type: 'shadow', dx: 16, dy: 20, sigma: 8, spread: 2, color: '#000000', opacity: 0.5 },
];

async function main() {
  const large = process.argv.includes('--large');
  const fresh = process.argv.includes('--fresh');
  await preloadSprites(ASSETS);
  fs.mkdirSync(PATCH_DIR, { recursive: true });
  setPatchCache(new PatchCache(PATCH_DIR, 24));

  if (!large) {
    const W = 1024, H = 768;
    const scene = SCENE_BUILDERS.grid(W, H);
    const sizes = [64, 128, 256, 512];
    console.log(`# 跨网格边缘误差对照  ${W}×${H}  filters=${JSON.stringify(CHAIN.map(f => f.type))}`);
    const t0 = Date.now();
    const rep = crossGridCompare(scene, CHAIN, sizes);
    for (const r of rep.results) {
      console.log(
        `  块 ${String(r.tileSize).padStart(4)}px  块数 ${String(r.tiles).padStart(4)}  ` +
        `邻域 ${String(r.maxHalo).padStart(2)}px  计算放大 ×${r.extraRatioMean.toFixed(2).padStart(5)}  ` +
        `边缘最大差 ${r.edgeMaxDiff}  边缘均差 ${r.edgeMeanDiff}  全图最大差 ${r.allMaxDiff}`,
      );
    }
    console.log(`  用时 ${Date.now() - t0}ms\n`);
    return;
  }

  // Large document under a restricted worker budget. Workers are separate
  // processes; the coordinator only reads tile crops for the final strip.
  const job = { scene: 'aurora', width: 12000, height: 9000, tileW: 512, tileH: 512, filters: CHAIN };
  // --fresh renders from scratch so the timings describe real work; without it
  // a warm cache reports what the cache-hit path costs instead.
  const cacheDir = fresh ? path.join(__dirname, '..', '.cache', 'bench-tiles-' + Date.now()) : undefined;
  const scheduler = new Scheduler({ workers: Number(process.env.WORKERS || 4), memoryLimitMb: 256, cacheDir });
  const t0 = Date.now();
  const run = await scheduler.run(job, {
    onPlan: (p, st) => console.log(`  计划: ${p.tiles} 块 ${p.cols}×${p.rows}, 最大邻域 ${p.maxHalo}px, 待算 ${st.missing}`),
  });
  const exportInfo = scheduler.exportRun(run);
  const rss = process.memoryUsage().rss;
  const rec = {
    document: `${job.width}×${job.height}`,
    tiles: run.plan.tiles.length,
    grid: `${run.plan.cols}×${run.plan.rows}`,
    wallMs: Date.now() - t0,
    tileRenderWallMs: run.stats.wallMs,
    peakNodeMb: run.stats.peakNodeMb,
    nodeLimitMb: run.stats.memoryLimitMb,
    exportStripPeakMb: exportInfo.peakMb,
    coordinatorRssMb: +(rss / 1048576).toFixed(1),
    outputBytes: exportInfo.bytes,
    cachedTiles: run.stats.cachedTiles,
    renderedTiles: run.stats.renderedTiles,
  };
  console.log('\n# 受限内存大图导出记录');
  for (const [k, v] of Object.entries(rec)) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`  output              ${exportInfo.file} (${mb(exportInfo.bytes)})`);
  console.log(`  document raw RGBA   ${mb(job.width * job.height * 4)} (never held whole by coordinator or any node)`);

  const out = path.join(__dirname, '..', '.cache', 'bench-large.json');
  fs.writeFileSync(out, JSON.stringify({ record: rec, fresh, events: run.events }, null, 2));
  console.log(`  记录写入            ${out}`);
  if (fresh) {
    fs.rmSync(cacheDir, { recursive: true, force: true });
    console.log('  临时缓存已删除');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
