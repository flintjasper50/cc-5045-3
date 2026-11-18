'use strict';
// Tile pipeline: grid planning, per-tile back-propagation, rendering and
// pixel comparison. The scheduler owns processes and disk; this module is pure
// computation so it can be unit-tested in-process.

const geom = require('./geometry');
const { hashOf } = require('./hash');
const { renderContent } = require('./scene');
const { normalizeChain, applyFilter } = require('./filters');
const { toRGBA8, quantizeSurface } = require('./image');

const KERNEL_VERSION = 'k3';
const MAX_TILES = 4096;
const DEFAULT_MEMORY_LIMIT_MB = 320;

// Cache key covers scene identity, document size, content mode and every
// normalized filter parameter. Pixel-affecting fields only.
function cfgHash(cfg, scene) {
  return hashOf({
    kernel: KERNEL_VERSION,
    scene: scene.id,
    sceneW: scene.width,
    sceneH: scene.height,
    content: cfg.content || 'full',
    filters: normalizeChain(cfg.filters, scene.width, scene.height).map(f => {
      const c = { ...f };
      delete c.blurSupport;
      return c;
    }),
  }, 20);
}

function planTiles(scene, cfg) {
  const tileW = Math.round(cfg.tileW);
  const tileH = Math.round(cfg.tileH || cfg.tileW);
  if (!(tileW >= 16) || !(tileH >= 16)) throw new Error('分块尺寸过小（最小 16px）');
  if (tileW > 8192 || tileH > 8192) throw new Error('分块尺寸过大（最大 8192px）');
  const docRect = geom.rect(0, 0, scene.width, scene.height);
  const grid = geom.makeGrid(docRect, tileW, tileH);
  if (grid.tiles.length > MAX_TILES) {
    throw new Error(`分块数 ${grid.tiles.length} 超过上限 ${MAX_TILES}，请增大分块尺寸`);
  }
  const filters = normalizeChain(cfg.filters, scene.width, scene.height);
  const tiles = grid.tiles.map(t => {
    const chain = geom.backPropChain(filters, t.crop);
    const contentRect = chain[0];
    const cropArea = Math.max(1, geom.area(t.crop));
    return {
      ...t,
      chain,
      contentRect,
      halo: geom.contains(contentRect, t.crop) ? {
        left: t.crop.x0 - contentRect.x0,
        top: t.crop.y0 - contentRect.y0,
        right: contentRect.x1 - t.crop.x1,
        bottom: contentRect.y1 - t.crop.y1,
      } : null,
      extraRatio: geom.area(contentRect) / cropArea,
      computeW: contentRect.x1 - contentRect.x0,
      computeH: contentRect.y1 - contentRect.y0,
    };
  });
  const maxHalo = tiles.reduce((m, t) => Math.max(m,
    (t.halo ? t.halo.left : 0), (t.halo ? t.halo.top : 0),
    (t.halo ? t.halo.right : 0), (t.halo ? t.halo.bottom : 0)), 0);
  return { tiles, cols: grid.cols, rows: grid.rows, tileW, tileH, filters, docRect, maxHalo };
}

// Render exactly one tile: content rect -> filter chain -> crop pixels.
function processTile(scene, filters, tile) {
  let cur = { surface: renderContent(scene, tile.contentRect), rect: tile.contentRect };
  for (let i = 0; i < filters.length; i++) {
    cur = applyFilter(filters[i], cur.surface, cur.rect, tile.chain[i + 1]);
  }
  const w = tile.crop.x1 - tile.crop.x0, h = tile.crop.y1 - tile.crop.y0;
  if (cur.surface.w !== w || cur.surface.h !== h) throw new Error('块输出尺寸不一致');
  return Buffer.from(toRGBA8(cur.surface));
}

// Full-document filtered render, used only for the small reference sample.
function renderReference(scene, filters, docRect = geom.rect(0, 0, scene.width, scene.height)) {
  const chain = geom.backPropChain(filters, docRect);
  let cur = { surface: renderContent(scene, chain[0]), rect: chain[0] };
  for (let i = 0; i < filters.length; i++) cur = applyFilter(filters[i], cur.surface, cur.rect, chain[i + 1]);
  return { data: toRGBA8(cur.surface), rect: docRect };
}

function tileCacheDescriptor(cfgKey, tile) {
  return hashOf({
    cfgKey,
    index: tile.index,
    crop: geom.toString(tile.crop),
    compute: geom.toString(tile.contentRect),
  }, 12);
}

// Compare each tile's pixels against a full-document reference image.
function compareToReference(tiles, readTile, ref, refRect) {
  const refW = refRect.x1 - refRect.x0;
  let maxDiff = 0, sum = 0, count = 0, worst = null;
  const perTile = [];
  for (const t of tiles) {
    const buf = readTile(t.index);
    const w = t.crop.x1 - t.crop.x0, h = t.crop.y1 - t.crop.y0;
    let localMax = 0, localSum = 0, localN = 0;
    for (let y = 0; y < h; y++) {
      const dy = t.crop.y0 + y;
      for (let x = 0; x < w; x++) {
        const dx = t.crop.x0 + x;
        const ai = (y * w + x) * 4;
        const bi = ((dy - refRect.y0) * refW + (dx - refRect.x0)) * 4;
        let d = 0;
        for (let c = 0; c < 4; c++) {
          const v = buf[ai + c] - ref[bi + c];
          const a = v < 0 ? -v : v;
          if (a > d) d = a;
        }
        if (d > localMax) localMax = d;
        localSum += d; localN++;
      }
    }
    perTile.push({ index: t.index, row: t.row, col: t.col, maxDiff: localMax, meanDiff: localN ? +(localSum / localN).toFixed(4) : 0 });
    maxDiff = Math.max(maxDiff, localMax);
    sum += localSum; count += localN;
    if (!worst || localMax > worst.maxDiff) worst = { index: t.index, row: t.row, col: t.col, maxDiff: localMax };
  }
  return { maxDiff, meanDiff: count ? +(sum / count).toFixed(5) : 0, pixels: count, worst, perTile };
}


// Human summary of a tile plan, including per-tile compute rects and halos.
function summarizePlan(plan) {
  const tiles = plan.tiles;
  const halos = tiles.map(t => t.halo || { left: 0, top: 0, right: 0, bottom: 0 });
  const maxHalo = halos.reduce((m, h) => Math.max(m, h.left, h.top, h.right, h.bottom), 0);
  const extra = tiles.map(t => t.extraRatio);
  return {
    cols: plan.cols, rows: plan.rows, tileW: plan.tileW, tileH: plan.tileH,
    tiles: tiles.length, maxHalo,
    extraRatioMax: +Math.max(...extra).toFixed(3),
    extraRatioMean: +(extra.reduce((a, b) => a + b, 0) / extra.length).toFixed(3),
    docW: plan.docRect.x1, docH: plan.docRect.y1,
    filters: plan.filters.map(f => {
      const { type, sigma, spread, dx, dy, scale, angle, cx, cy, color, opacity } = f;
      return { type, sigma, spread, dx, dy, scale, angle, cx, cy, color, opacity };
    }),
    tileList: tiles.map(t => ({
      index: t.index, row: t.row, col: t.col,
      crop: t.crop,
      contentRect: t.contentRect,
      computeRect: t.contentRect,
      computeW: t.computeW, computeH: t.computeH,
      halo: t.halo,
      extraRatio: +t.extraRatio.toFixed(3),
    })),
  };
}

// Cross-grid edge-error comparison: render the same document at several tile
// sizes and compare each grid's boundary-adjacent pixels against the whole
// document rendered in one piece. A seam from truncated support would show up
// as a large boundary error; with correct halo propagation it stays zero.
// The whole-image buffer is the reference sample only, not the export path.
function crossGridCompare(scene, filters, tileSizes) {
  const filtersN = normalizeChain(filters, scene.width, scene.height);
  const W = scene.width, H = scene.height;
  const ref = renderReference(scene, filtersN);
  const refData = ref.data;
  const results = [];

  for (const size of tileSizes) {
    const plan = planTiles(scene, { tileW: size, tileH: size, filters });
    const out = Buffer.allocUnsafe(W * H * 4);
    // 1 = pixel sits next to a tile boundary in this grid
    const edge = new Uint8Array(W * H);
    for (const t of plan.tiles) {
      const buf = processTile(scene, filtersN, t);
      const w = t.crop.x1 - t.crop.x0, h = t.crop.y1 - t.crop.y0;
      for (let y = 0; y < h; y++) {
        buf.copy(out, ((t.crop.y0 + y) * W + t.crop.x0) * 4, y * w * 4, (y + 1) * w * 4);
      }
      for (let y = 0; y < h; y++) {
        edge[(t.crop.y0 + y) * W + t.crop.x0] = 1;
        edge[(t.crop.y0 + y) * W + t.crop.x1 - 1] = 1;
      }
      for (let x = 0; x < w; x++) {
        edge[t.crop.y0 * W + t.crop.x0 + x] = 1;
        edge[(t.crop.y1 - 1) * W + t.crop.x0 + x] = 1;
      }
    }
    let edgeMax = 0, edgeSum = 0, edgeN = 0;
    let allMax = 0, allSum = 0, allN = 0;
    let worst = null;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        let d = 0;
        for (let c = 0; c < 4; c++) {
          const v = out[i + c] - refData[i + c];
          const ad = v < 0 ? -v : v;
          if (ad > d) d = ad;
        }
        if (d > allMax) allMax = d;
        allSum += d; allN++;
        if (edge[y * W + x]) {
          if (d > edgeMax) { edgeMax = d; worst = { x, y, diff: d }; }
          edgeSum += d; edgeN++;
        }
      }
    }
    results.push({
      tileSize: size, tiles: plan.tiles.length,
      maxHalo: plan.maxHalo,
      extraRatioMean: +(plan.tiles.reduce((s, t) => s + t.extraRatio, 0) / plan.tiles.length).toFixed(3),
      edgePixels: edgeN,
      edgeMaxDiff: edgeMax,
      edgeMeanDiff: edgeN ? +(edgeSum / edgeN).toFixed(5) : 0,
      allMaxDiff: allMax,
      allMeanDiff: allN ? +(allSum / allN).toFixed(5) : 0,
      worstEdge: worst,
    });
  }
  return { width: W, height: H, filters: filtersN, results };
}

module.exports = {
  KERNEL_VERSION, MAX_TILES, DEFAULT_MEMORY_LIMIT_MB, cfgHash, planTiles, processTile,
  renderReference, compareToReference, tileCacheDescriptor, summarizePlan, crossGridCompare,
};
