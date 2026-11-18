'use strict';
// Boundary-material pack tests. The archived demo set under demo/ is loaded
// and verified for real: stitch difference against the complete reference,
// exact valid-region coverage, declared neighbourhood vs the kernel's
// back-propagation, and byte-identical re-rendering. The pack must not hide
// behind default values.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  planTiles, processTile, renderReference, compareToReference,
} = require('../src/kernel/pipeline');
const { SCENE_BUILDERS, preloadSprites, ASSETS, setPatchCache, PatchCache, renderContent } = require('../src/kernel/scene');
const { normalizeChain, FILTERS } = require('../src/kernel/filters');
const geom = require('../src/kernel/geometry');
const {
  PACK_SPEC, PACK_VERSION, loadManifest, verifyBoundaryPack, specAvoidsDefaults,
  assembleTiles, validRegionReport,
} = require('../src/kernel/boundary-pack');

const PACK_DIR = path.join(__dirname, '..', 'demo', 'boundary-pack');
const PATCH_DIR = path.join(os.tmpdir(), 'megaposter-test-patches');

test.before(async () => {
  await preloadSprites(ASSETS);
  fs.mkdirSync(PATCH_DIR, { recursive: true });
  setPatchCache(new PatchCache(PATCH_DIR, 24));
});

test('boundary scene ships fine lines, alpha edges and wide-radius effects', () => {
  const scene = SCENE_BUILDERS.boundary(760, 532);
  const u = Math.min(760, 532);
  const lines = scene.elements.filter(e => e.type === 'line');
  assert.ok(lines.length >= 4, '细线元素不足');
  for (const l of lines) assert.ok(l.width <= u * 0.004, `细线 ${l.id} 过宽: ${l.width}`);
  // Lines span the document so any grid slices them.
  assert.ok(lines.some(l => l.x0 === 0 && l.x1 === 760), '缺少横贯整幅的水平细线');
  assert.ok(lines.some(l => l.y0 === 0 && l.y1 === 532), '缺少纵贯整幅的垂直细线');
  const glows = scene.elements.filter(e => e.type === 'circle' && e.glow && e.r >= u * 0.25);
  assert.ok(glows.length >= 2, '大半径柔光不足');
  const fades = scene.elements.filter(e => e.glow && /,0\)$/.test(e.glow[1]));
  assert.ok(fades.length >= 3, '渐隐透明边缘素材不足');
  assert.ok(scene.elements.some(e => e.type === 'sprite'), '缺少透明 PNG 精灵');
});

test('boundary scene keeps a transparent outer margin (no opaque backdrop)', () => {
  const scene = SCENE_BUILDERS.boundary(760, 532);
  // Render the four corners directly: outside the texture island every pixel
  // must stay fully transparent, which is what exercises halo math at the
  // document's transparent outer edge.
  for (const [x0, y0] of [[0, 0], [760 - 8, 0], [0, 532 - 8], [760 - 8, 532 - 8]]) {
    const surf = renderContent(scene, geom.rect(x0, y0, x0 + 8, y0 + 8));
    for (let i = 3; i < surf.data.length; i += 4) {
      assert.strictEqual(surf.data[i], 0, `角落 (${x0},${y0}) 应全透明`);
    }
  }
  // ...while the centre is covered by the texture island.
  const tex = scene.elements.find(e => e.type === 'texture');
  assert.ok(tex.rect.x > 0 && tex.rect.y > 0, '纹理必须让出透明外缘');
  assert.ok(tex.rect.x + tex.rect.w < 760 && tex.rect.y + tex.rect.h < 532);
});

test('pack spec never hides behind default values', () => {
  const issues = specAvoidsDefaults(PACK_SPEC);
  assert.deepStrictEqual(issues, [], issues.join('; '));
  // Explicitly: every numeric filter field differs from the filter default.
  for (const f of PACK_SPEC.filters) {
    const def = FILTERS[f.type];
    for (const [k, p] of Object.entries(def.params)) {
      if (p.type === 'color' || f[k] === undefined) continue;
      assert.notStrictEqual(f[k], p.default, `${f.type}.${k} 不得取默认值`);
    }
  }
  for (const s of PACK_SPEC.tileSizes) {
    assert.ok(PACK_SPEC.width % s !== 0 || PACK_SPEC.height % s !== 0, `分块 ${s} 整除画幅`);
  }
});

test('the archived demo pack really exists on disk', () => {
  assert.ok(fs.existsSync(PACK_DIR), 'demo/boundary-pack 不存在');
  const manifest = loadManifest(PACK_DIR);
  assert.strictEqual(manifest.packVersion, PACK_VERSION);
  assert.ok(fs.existsSync(path.join(PACK_DIR, manifest.reference.file)), '缺少完整参考');
  assert.ok(manifest.sets.length >= 2, '分块输出集合不足');
  for (const set of manifest.sets) {
    const plan = JSON.parse(fs.readFileSync(path.join(PACK_DIR, set.dir, 'plan.json'), 'utf8'));
    assert.strictEqual(plan.entries.length, set.tiles);
    for (const e of plan.entries) {
      const file = path.join(PACK_DIR, set.dir, e.file);
      assert.ok(fs.existsSync(file), `缺少分块输出 ${set.dir}/${e.file}`);
      const w = e.crop.x1 - e.crop.x0, h = e.crop.y1 - e.crop.y0;
      assert.strictEqual(fs.statSync(file).size, w * h * 4, `${e.file} 尺寸与有效区不符`);
    }
  }
  // Production-time checks were recorded in the manifest.
  assert.strictEqual(manifest.checks.stitchMaxDiff, 0);
  assert.strictEqual(manifest.checks.validCoverage, 'exact');
  assert.strictEqual(manifest.checks.rerenderIdentical, true);
});

test('manifest declares the valid region and the neighbourhood explicitly', () => {
  const manifest = loadManifest(PACK_DIR);
  assert.deepStrictEqual(manifest.validRegion, { x0: 0, y0: 0, x1: PACK_SPEC.width, y1: PACK_SPEC.height });
  const filters = normalizeChain(manifest.filters, PACK_SPEC.width, PACK_SPEC.height);
  const supports = filters.map(f => geom.filterSupport(f));
  assert.deepStrictEqual(manifest.neighborhood.perFilter.map(p => p.support), supports);
  const scene = SCENE_BUILDERS.boundary(PACK_SPEC.width, PACK_SPEC.height);
  for (const size of manifest.tileSizes) {
    const plan = planTiles(scene, { tileW: size, tileH: size, filters: manifest.filters });
    assert.ok(plan.maxHalo > 0, '滤镜链必须产生非零邻域');
    assert.strictEqual(plan.maxHalo, manifest.neighborhood.maxHalo, '声明邻域与内核反推不一致');
    for (const t of plan.tiles) {
      assert.ok(geom.contains(t.contentRect, t.crop), '计算范围必须覆盖有效区');
    }
  }
});

test('valid regions of every archived set tile the document exactly', () => {
  const manifest = loadManifest(PACK_DIR);
  const scene = SCENE_BUILDERS.boundary(PACK_SPEC.width, PACK_SPEC.height);
  for (const set of manifest.sets) {
    const plan = planTiles(scene, { tileW: set.tileSize, tileH: set.tileSize, filters: manifest.filters });
    const report = validRegionReport(plan, manifest.validRegion);
    assert.ok(report.ok, `${set.dir}: ${report.problems.join('; ')}`);
  }
});

test('pack verification passes: stitch diff, halos and re-render all agree', async () => {
  const report = await verifyBoundaryPack(PACK_DIR, { patchDir: PATCH_DIR });
  assert.deepStrictEqual(report.problems, [], report.problems.join('; '));
  assert.strictEqual(report.stitch.maxDiff, 0, '拼接差值必须为 0');
  assert.strictEqual(report.boundary.maxDiff, 0, '边界带差值必须为 0');
  assert.strictEqual(report.validRegion.ok, true);
  assert.strictEqual(report.haloConsistent, true);
  assert.strictEqual(report.rerender.identical, true);
  assert.ok(report.ok);
});

test('recomputed tile sizes still reconstruct the same filtered document', () => {
  // The recompute demonstration: changing the tile size changes only the grid,
  // never the pixels. Sizes here are not the archived ones.
  const scene = SCENE_BUILDERS.boundary(PACK_SPEC.width, PACK_SPEC.height);
  const filters = normalizeChain(PACK_SPEC.filters, PACK_SPEC.width, PACK_SPEC.height);
  const ref = renderReference(scene, filters);
  for (const size of [120, 192, 260]) {
    const plan = planTiles(scene, { tileW: size, tileH: size, filters: PACK_SPEC.filters });
    const cmp = compareToReference(plan.tiles, (i) => processTile(scene, filters, plan.tiles[i]), ref.data, ref.rect);
    assert.strictEqual(cmp.maxDiff, 0, `分块 ${size}: 与整幅参照差 ${cmp.maxDiff}`);
  }
});

test('assembled archived tiles equal the reference for every set', async () => {
  const manifest = loadManifest(PACK_DIR);
  const scene = SCENE_BUILDERS.boundary(PACK_SPEC.width, PACK_SPEC.height);
  const { decodePng } = require('../src/kernel/png');
  const ref = decodePng(fs.readFileSync(path.join(PACK_DIR, manifest.reference.file)));
  for (const set of manifest.sets) {
    const plan = planTiles(scene, { tileW: set.tileSize, tileH: set.tileSize, filters: manifest.filters });
    const planDoc = JSON.parse(fs.readFileSync(path.join(PACK_DIR, set.dir, 'plan.json'), 'utf8'));
    const asm = assembleTiles(plan, (t) => fs.readFileSync(path.join(PACK_DIR, set.dir, planDoc.entries[t.index].file)));
    assert.strictEqual(asm.uncovered, 0);
    assert.strictEqual(asm.overlapped, 0);
    assert.ok(asm.out.equals(ref.data), `${set.dir}: 拼接结果与完整参考不一致`);
  }
});
