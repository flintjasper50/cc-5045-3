'use strict';
// Boundary-material pack: production and verification of the tiled-filter demo
// set. A pack archives, on disk and in the repo:
//
//   manifest.json   source + parameters (scene, doc size, seed, filter chain,
//                   tile sizes), the declared valid region and neighbourhood,
//                   and the check results recorded at production time
//   reference.png   the whole-document filtered render (the complete reference)
//   tiles-<size>/   per-tile outputs (raw RGBA8 .bin, the kernel cache format)
//                   plus plan.json declaring each tile's valid region (crop)
//                   and neighbourhood (halo / compute rect)
//
// Verification reloads the archived tiles, reassembles them and compares
// against the reference (stitch difference), checks that the valid regions
// tile the document exactly, that declared halos still match the kernel's
// back-propagation, and that re-rendering reproduces the archived bytes.
// Nothing here is pre-composited seamless imagery: every tile is produced by
// the real filter pipeline with halo back-propagation.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const geom = require('./geometry');
const { planTiles, processTile, renderReference, summarizePlan, KERNEL_VERSION } = require('./pipeline');
const { normalizeChain, FILTERS } = require('./filters');
const { SCENE_BUILDERS, preloadSprites, ASSETS, setPatchCache, PatchCache } = require('./scene');
const { encodePng, decodePng } = require('./png');
const { hashOf } = require('./hash');

const PACK_VERSION = 1;

// The demo-set specification. Deliberately *not* default values: the blur
// sigma is not the filter default, the shadow chain differs on every field,
// the document is not a power of two, and none of the tile sizes divide it —
// so a pack regenerated with defaults cannot masquerade as this one.
const PACK_SPEC = {
  pack: 'boundary-pack',
  label: '边界素材示范集（细线 + 透明边缘 + 大半径柔光）',
  scene: 'boundary',
  width: 760,
  height: 532,
  seed: 4021,
  filters: [
    { type: 'blur', sigma: 13 },
    { type: 'shadow', dx: -21, dy: 27, sigma: 11, spread: 5, color: '#24143a', opacity: 0.62 },
  ],
  tileSizes: [96, 160, 224],
};

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function tileFileName(index) { return 'tile-' + String(index).padStart(4, '0') + '.bin'; }

// Per-filter neighbourhood (geometric support) as declared by the kernel.
function filterSupports(filters) {
  return filters.map(f => ({ type: f.type, support: geom.filterSupport(f) }));
}

// Assemble archived tiles into one document buffer. Returns the buffer plus
// coverage evidence: every document pixel must be written exactly once.
function assembleTiles(plan, readTile) {
  const W = plan.docRect.x1 - plan.docRect.x0, H = plan.docRect.y1 - plan.docRect.y0;
  const out = Buffer.allocUnsafe(W * H * 4);
  const cover = new Uint16Array(W * H);
  for (const t of plan.tiles) {
    const buf = readTile(t);
    const w = t.crop.x1 - t.crop.x0, h = t.crop.y1 - t.crop.y0;
    if (buf.length !== w * h * 4) {
      throw new Error(`块 #${t.index} 字节数 ${buf.length} 与有效区 ${w}×${h} 不符`);
    }
    for (let y = 0; y < h; y++) {
      buf.copy(out, ((t.crop.y0 + y) * W + t.crop.x0) * 4, y * w * 4, (y + 1) * w * 4);
      for (let x = 0; x < w; x++) cover[(t.crop.y0 + y) * W + t.crop.x0 + x]++;
    }
  }
  let uncovered = 0, overlapped = 0;
  for (let i = 0; i < cover.length; i++) {
    if (cover[i] === 0) uncovered++;
    else if (cover[i] > 1) overlapped++;
  }
  return { out, width: W, height: H, uncovered, overlapped };
}

// Max per-channel absolute difference between two same-size RGBA buffers.
function diffBuffers(a, b) {
  if (a.length !== b.length) throw new Error(`长度不一致: ${a.length} vs ${b.length}`);
  let max = 0, sum = 0;
  const n = a.length / 4;
  for (let i = 0; i < a.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) {
      const v = a[i + c] - b[i + c];
      const av = v < 0 ? -v : v;
      if (av > d) d = av;
    }
    if (d > max) max = d;
    sum += d;
  }
  return { maxDiff: max, meanDiff: n ? +(sum / n).toFixed(6) : 0, pixels: n };
}

// Boundary band (2px inside each tile's valid region) diff against the
// reference — the stitch-error metric the panel reports.
function boundaryDiff(plan, assembled, refData) {
  const W = plan.docRect.x1 - plan.docRect.x0;
  let max = 0, sum = 0, n = 0;
  for (const t of plan.tiles) {
    const w = t.crop.x1 - t.crop.x0, h = t.crop.y1 - t.crop.y0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x >= 2 && y >= 2 && x < w - 2 && y < h - 2) continue;
        const i = ((t.crop.y0 + y) * W + (t.crop.x0 + x)) * 4;
        let d = 0;
        for (let c = 0; c < 4; c++) {
          const v = assembled[i + c] - refData[i + c];
          const av = v < 0 ? -v : v;
          if (av > d) d = av;
        }
        if (d > max) max = d;
        sum += d; n++;
      }
    }
  }
  return { maxDiff: max, meanDiff: n ? +(sum / n).toFixed(6) : 0, pixels: n };
}

// Valid-region coverage proof for a plan: crops are interior-disjoint and
// their union is exactly the declared valid region.
function validRegionReport(plan, validRegion) {
  const doc = geom.rect(validRegion.x0, validRegion.y0, validRegion.x1, validRegion.y1);
  let union = null;
  const problems = [];
  for (const t of plan.tiles) {
    if (!geom.contains(doc, t.crop)) problems.push(`块 #${t.index} 的有效区越出声明有效区`);
    union = union ? geom.union(union, t.crop) : t.crop;
    for (const o of plan.tiles) {
      if (o.index <= t.index) continue;
      if (geom.intersects(t.crop, o.crop)) problems.push(`块 #${t.index} 与 #${o.index} 的有效区重叠`);
    }
  }
  if (union && !geom.same(union, doc)) problems.push('有效区并集不等于声明有效区');
  return { ok: problems.length === 0, problems, union };
}

async function prepareKernel(patchDir) {
  await preloadSprites(ASSETS);
  fs.mkdirSync(patchDir, { recursive: true });
  setPatchCache(new PatchCache(patchDir, 24));
}

// Sub-patch raster cache is regenerable build state, so it lives in the shared
// app cache, never inside the archived pack.
function defaultPatchDir() {
  return path.join(__dirname, '..', '..', '.cache', 'patches');
}

// Produce the full pack into `dir`. Deterministic: same kernel + same spec
// yields byte-identical files.
async function buildBoundaryPack(dir, opts = {}) {
  const spec = opts.spec || PACK_SPEC;
  const patchDir = opts.patchDir || defaultPatchDir();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await prepareKernel(patchDir);

  const scene = SCENE_BUILDERS[spec.scene](spec.width, spec.height);
  const filters = normalizeChain(spec.filters, spec.width, spec.height);
  const docRect = geom.rect(0, 0, spec.width, spec.height);

  // Complete reference: the whole document filtered in one pass.
  const ref = renderReference(scene, filters, docRect);
  const refPng = encodePng(spec.width, spec.height, ref.data);
  fs.writeFileSync(path.join(dir, 'reference.png'), refPng);

  const sets = [];
  for (const size of spec.tileSizes) {
    const plan = planTiles(scene, { tileW: size, tileH: size, filters: spec.filters });
    const setDir = path.join(dir, 'tiles-' + size);
    fs.mkdirSync(setDir, { recursive: true });
    const entries = [];
    for (const t of plan.tiles) {
      const buf = processTile(scene, filters, t);
      const file = tileFileName(t.index);
      fs.writeFileSync(path.join(setDir, file), buf);
      entries.push({
        index: t.index, row: t.row, col: t.col,
        crop: t.crop, contentRect: t.contentRect, halo: t.halo,
        file, sha256: sha256(buf),
      });
    }
    const planDoc = {
      tileSize: size, cols: plan.cols, rows: plan.rows, tiles: plan.tiles.length,
      maxHalo: plan.maxHalo,
      validRegion: { x0: docRect.x0, y0: docRect.y0, x1: docRect.x1, y1: docRect.y1 },
      entries,
    };
    fs.writeFileSync(path.join(setDir, 'plan.json'), JSON.stringify(planDoc, null, 2));
    sets.push({
      tileSize: size, cols: plan.cols, rows: plan.rows, tiles: plan.tiles.length,
      maxHalo: plan.maxHalo, dir: 'tiles-' + size,
    });
  }

  const manifest = {
    pack: spec.pack,
    label: spec.label,
    packVersion: PACK_VERSION,
    generator: { name: 'make-boundary-pack', kernel: KERNEL_VERSION, packVersion: PACK_VERSION },
    source: {
      scene: spec.scene, width: spec.width, height: spec.height, seed: spec.seed,
      note: '细线(1–2px) + 透明边缘(径向渐隐/半透明精灵) + 大半径柔光；四周 9% 透明外缘，无全幅不透明底。',
    },
    filters: spec.filters,
    validRegion: { x0: docRect.x0, y0: docRect.y0, x1: docRect.x1, y1: docRect.y1 },
    transparentMargin: { x: Math.round(spec.width * 0.09), y: Math.round(spec.height * 0.09) },
    neighborhood: {
      maxHalo: Math.max(...sets.map(s => s.maxHalo)),
      perFilter: filterSupports(filters),
      meaning: '每块有效区(crop)之外需要额外计算的邻域宽度，由滤镜支撑沿链反向推导',
    },
    tileSizes: spec.tileSizes,
    sets,
    reference: { file: 'reference.png', width: spec.width, height: spec.height, sha256: sha256(refPng) },
    checks: null, // filled by verifyBoundaryPack at production time
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Verify what we just wrote and record the evidence inside the manifest.
  const report = await verifyBoundaryPack(dir, { patchDir });
  manifest.checks = {
    stitchMaxDiff: report.stitch.maxDiff,
    stitchMeanDiff: report.stitch.meanDiff,
    boundaryMaxDiff: report.boundary.maxDiff,
    validCoverage: report.validRegion.ok ? 'exact' : 'broken',
    haloConsistent: report.haloConsistent,
    rerenderIdentical: report.rerender.identical,
    verifiedAt: manifest.createdAt,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  if (!report.ok) {
    const err = new Error('示范集自检失败: ' + report.problems.join('; '));
    err.report = report;
    throw err;
  }
  return { manifest, report };
}

function loadManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error('缺少 manifest.json: ' + dir);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Verify an archived pack against the current kernel. Returns a structured
// report; `ok` is true only when every check passes.
async function verifyBoundaryPack(dir, opts = {}) {
  const manifest = loadManifest(dir);
  const patchDir = opts.patchDir || defaultPatchDir();
  await prepareKernel(patchDir);

  const problems = [];
  const { scene: sceneId, width, height } = manifest.source;
  if (!SCENE_BUILDERS[sceneId]) throw new Error('未知场景: ' + sceneId);
  const scene = SCENE_BUILDERS[sceneId](width, height);
  const filters = normalizeChain(manifest.filters, width, height);

  // 1. reference.png integrity
  const refFile = path.join(dir, manifest.reference.file);
  if (!fs.existsSync(refFile)) throw new Error('缺少完整参考: ' + refFile);
  const refPng = fs.readFileSync(refFile);
  if (sha256(refPng) !== manifest.reference.sha256) problems.push('reference.png 与清单哈希不符');
  const refImg = decodePng(refPng);
  if (refImg.width !== width || refImg.height !== height) problems.push('reference.png 尺寸与来源不符');

  // 2. The reference itself must equal the kernel's whole-document render —
  //    this is what ties the archived pack to the current kernel.
  const refNow = renderReference(scene, filters, geom.rect(0, 0, width, height));
  const refDiff = diffBuffers(refImg.data, refNow.data);
  if (refDiff.maxDiff !== 0) problems.push(`完整参考与当前内核整幅渲染不一致 (max=${refDiff.maxDiff})`);

  const setReports = [];
  let stitch = { maxDiff: 0, meanDiff: 0, pixels: 0 };
  let boundary = { maxDiff: 0, meanDiff: 0, pixels: 0 };
  let validOk = true;
  let haloConsistent = true;
  let rerenderIdentical = true;

  for (const set of manifest.sets) {
    const setDir = path.join(dir, set.dir);
    const planDoc = JSON.parse(fs.readFileSync(path.join(setDir, 'plan.json'), 'utf8'));
    // Re-plan with the current kernel: declared halos must still hold.
    const plan = planTiles(scene, { tileW: set.tileSize, tileH: set.tileSize, filters: manifest.filters });
    if (plan.tiles.length !== planDoc.entries.length) problems.push(`${set.dir}: 块数与当前内核不一致`);
    for (const e of planDoc.entries) {
      const t = plan.tiles[e.index];
      if (!t) { haloConsistent = false; continue; }
      if (!geom.same(t.crop, e.crop) || !geom.same(t.contentRect, e.contentRect)) haloConsistent = false;
    }
    if (plan.maxHalo !== planDoc.maxHalo) haloConsistent = false;

    // Valid-region coverage on the declared plan.
    const valid = validRegionReport(plan, manifest.validRegion);
    if (!valid.ok) { validOk = false; problems.push(...valid.problems.map(p => set.dir + ': ' + p)); }

    // Stitch difference: archived tiles reassembled vs the complete reference.
    const asm = assembleTiles(plan, (t) => {
      const e = planDoc.entries[t.index];
      const buf = fs.readFileSync(path.join(setDir, e.file));
      if (sha256(buf) !== e.sha256) problems.push(`${set.dir}/${e.file}: 哈希与清单不符`);
      return buf;
    });
    if (asm.uncovered || asm.overlapped) {
      validOk = false;
      problems.push(`${set.dir}: 有效区覆盖不完整 (缺 ${asm.uncovered}, 重 ${asm.overlapped})`);
    }
    const sd = diffBuffers(asm.out, refImg.data);
    const bd = boundaryDiff(plan, asm.out, refImg.data);
    if (sd.maxDiff > stitch.maxDiff) stitch = sd;
    if (bd.maxDiff > boundary.maxDiff) boundary = bd;
    if (sd.maxDiff !== 0) problems.push(`${set.dir}: 拼接差值 max=${sd.maxDiff}`);

    // Re-render every tile with the current kernel: bytes must be identical.
    let rerenderOk = true;
    for (const t of plan.tiles) {
      const now = processTile(scene, filters, t);
      const e = planDoc.entries[t.index];
      const archived = fs.readFileSync(path.join(setDir, e.file));
      if (!now.equals(archived)) { rerenderOk = false; break; }
    }
    if (!rerenderOk) { rerenderIdentical = false; problems.push(set.dir + ': 重渲染与入库块不一致'); }

    setReports.push({
      dir: set.dir, tileSize: set.tileSize, tiles: plan.tiles.length,
      maxHalo: plan.maxHalo,
      stitch: sd, boundary: bd,
      validRegion: { ok: valid.ok, uncovered: asm.uncovered, overlapped: asm.overlapped },
      rerenderIdentical: rerenderOk,
    });
  }

  // Declared neighbourhood must match the kernel's back-propagation.
  const supports = filterSupports(filters);
  const declared = manifest.neighborhood && manifest.neighborhood.perFilter;
  if (!declared || declared.length !== supports.length
      || declared.some((d, i) => d.type !== supports[i].type || d.support !== supports[i].support)) {
    haloConsistent = false;
    problems.push('声明的邻域范围与内核滤镜支撑不一致');
  }
  const maxHaloNow = Math.max(...setReports.map(s => s.maxHalo));
  if (manifest.neighborhood.maxHalo !== maxHaloNow) {
    haloConsistent = false;
    problems.push(`声明的最大邻域 ${manifest.neighborhood.maxHalo} 与当前内核 ${maxHaloNow} 不符`);
  }

  const ok = problems.length === 0 && stitch.maxDiff === 0 && validOk && haloConsistent && rerenderIdentical;
  return {
    ok, problems, manifest,
    reference: { diff: refDiff },
    stitch, boundary,
    validRegion: { ok: validOk },
    haloConsistent,
    rerender: { identical: rerenderIdentical },
    sets: setReports,
  };
}

// Guard against a pack that hides errors behind default values: the spec must
// differ from every filter default and use non-power-of-two tiling.
function specAvoidsDefaults(spec = PACK_SPEC) {
  const issues = [];
  for (const f of spec.filters) {
    const def = FILTERS[f.type];
    if (!def) { issues.push('未知滤镜 ' + f.type); continue; }
    for (const [k, p] of Object.entries(def.params)) {
      if (p.type === 'color') continue;
      if (f[k] !== undefined && f[k] === p.default) issues.push(`${f.type}.${k} 仍是默认值 ${p.default}`);
    }
  }
  for (const s of spec.tileSizes) {
    if ((s & (s - 1)) === 0) issues.push(`分块尺寸 ${s} 是 2 的幂，掩盖不整除情形`);
    if (spec.width % s === 0 && spec.height % s === 0) issues.push(`分块尺寸 ${s} 整除画幅`);
  }
  return issues;
}

module.exports = {
  PACK_VERSION, PACK_SPEC,
  buildBoundaryPack, verifyBoundaryPack, loadManifest,
  assembleTiles, diffBuffers, boundaryDiff, validRegionReport, specAvoidsDefaults,
  summarizePlan,
};
