'use strict';
// Tile-independence tests. These run in-process (no worker processes) so they
// can assert on exact pixels: any tile-size-dependent change is a failure.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  planTiles, processTile, renderReference, compareToReference, cfgHash,
  crossGridCompare, KERNEL_VERSION,
} = require('../src/kernel/pipeline');
const { SCENE_BUILDERS, preloadSprites, ASSETS, setPatchCache, PatchCache } = require('../src/kernel/scene');
const { normalizeChain } = require('../src/kernel/filters');

const PATCH_DIR = path.join(os.tmpdir(), 'megaposter-test-patches');

test.before(async () => {
  await preloadSprites(ASSETS);
  fs.mkdirSync(PATCH_DIR, { recursive: true });
  setPatchCache(new PatchCache(PATCH_DIR, 24));
});

const CHAINS = {
  none: [],
  blur: [{ type: 'blur', sigma: 8 }],
  shadow: [{ type: 'shadow', dx: 18, dy: 24, sigma: 10, spread: 2, color: '#000000', opacity: 0.55 }],
  resample: [{ type: 'resample', scale: 1.15, angle: 8, cx: 0.5, cy: 0.5 }],
  chain: [
    { type: 'blur', sigma: 5 },
    { type: 'shadow', dx: 12, dy: 9, sigma: 6, spread: 1, color: '#112233', opacity: 0.5 },
  ],
};

// Assemble a grid's tiles into one document-sized buffer, via processTile.
function assemble(scene, filters, tileSize) {
  const plan = planTiles(scene, { tileW: tileSize, tileH: tileSize, filters });
  const f = normalizeChain(filters, scene.width, scene.height);
  const W = scene.width, H = scene.height;
  const out = Buffer.allocUnsafe(W * H * 4);
  for (const t of plan.tiles) {
    const buf = processTile(scene, f, t);
    const w = t.crop.x1 - t.crop.x0, h = t.crop.y1 - t.crop.y0;
    for (let y = 0; y < h; y++) {
      buf.copy(out, ((t.crop.y0 + y) * W + t.crop.x0) * 4, y * w * 4, (y + 1) * w * 4);
    }
  }
  return { out, plan };
}

test('every tile equals the whole-document reference for each filter chain', () => {
  const W = 512, H = 384;
  for (const sceneId of ['grid', 'aurora']) {
    const scene = SCENE_BUILDERS[sceneId](W, H);
    for (const [name, filters] of Object.entries(CHAINS)) {
      const f = normalizeChain(filters, W, H);
      const ref = renderReference(scene, f);
      for (const size of [61, 128, 256]) {
        const plan = planTiles(scene, { tileW: size, tileH: size, filters });
        const cmp = compareToReference(plan.tiles, (i) => processTile(scene, f, plan.tiles[i]), ref.data, ref.rect);
        assert.strictEqual(cmp.maxDiff, 0,
          `${sceneId}/${name}/${size}: max pixel diff ${cmp.maxDiff} (worst tile #${cmp.worst && cmp.worst.index})`);
      }
    }
  }
});

test('changing the tile size never changes the assembled image', () => {
  const W = 400, H = 300;
  const scene = SCENE_BUILDERS.grid(W, H);
  for (const [name, filters] of Object.entries(CHAINS)) {
    const sizes = [64, 97, 128, 200, 256];
    const base = assemble(scene, filters, sizes[0]).out;
    for (const size of sizes.slice(1)) {
      const other = assemble(scene, filters, size).out;
      assert.ok(base.equals(other), `${name}: tile size ${size} differs from ${sizes[0]}`);
    }
  }
});

test('cross-grid edge error is zero for every grid', () => {
  const scene = SCENE_BUILDERS.aurora(320, 240);
  const report = crossGridCompare(scene, CHAINS.shadow, [32, 64, 128]);
  for (const r of report.results) {
    assert.strictEqual(r.edgeMaxDiff, 0, `tile ${r.tileSize}: edge diff ${r.edgeMaxDiff}`);
    assert.strictEqual(r.allMaxDiff, 0, `tile ${r.tileSize}: full diff ${r.allMaxDiff}`);
  }
});

test('halo grows with filter support and compute rects cover the crop', () => {
  const scene = SCENE_BUILDERS.grid(512, 512);
  const none = planTiles(scene, { tileW: 128, filters: [] });
  const blur = planTiles(scene, { tileW: 128, filters: CHAINS.blur });
  assert.strictEqual(none.maxHalo, 0);
  assert.ok(blur.maxHalo > 0);
  for (const t of blur.tiles) {
    assert.ok(t.contentRect.x0 <= t.crop.x0 && t.contentRect.y0 <= t.crop.y0);
    assert.ok(t.contentRect.x1 >= t.crop.x1 && t.contentRect.y1 >= t.crop.y1);
  }
});

test('cache key tracks every pixel-affecting input', () => {
  const sceneA = SCENE_BUILDERS.grid(256, 256);
  const sceneB = SCENE_BUILDERS.aurora(256, 256);
  const base = { tileW: 64, filters: CHAINS.blur };
  const a = cfgHash(base, sceneA);
  assert.strictEqual(a, cfgHash({ ...base }, sceneA), 'identical config must hash identically');
  assert.notStrictEqual(a, cfgHash({ ...base, filters: CHAINS.shadow }, sceneA), 'filter change must invalidate');
  assert.notStrictEqual(a, cfgHash({ ...base, filters: [{ type: 'blur', sigma: 9 }] }, sceneA), 'param change must invalidate');
  assert.notStrictEqual(a, cfgHash(base, sceneB), 'scene change must invalidate');
  const sceneC = SCENE_BUILDERS.grid(512, 256);
  assert.notStrictEqual(a, cfgHash(base, sceneC), 'document size change must invalidate');
});

test('kernel version participates in the cache key', () => {
  // Guards against stale tiles surviving a kernel change.
  const scene = SCENE_BUILDERS.grid(256, 256);
  const key = cfgHash({ tileW: 64, filters: [] }, scene);
  const { hashOf } = require('../src/kernel/hash');
  const expected = hashOf({
    kernel: KERNEL_VERSION,
    scene: scene.id, sceneW: scene.width, sceneH: scene.height,
    content: 'full', filters: [],
  }, 20);
  assert.strictEqual(key, expected);
});
