'use strict';
// Poster scenes and their assembly. Content = per-pixel procedural texture below
// + locally-rasterized element patches above. Both are addressed by document
// coordinates only, so any document rect renders identically for every tile.

const path = require('path');
const { createSurface, fillSurface, Q } = require('./image');
const { NoiseField, hash2 } = require('./hash');
const { preloadSprites, elementBounds, subPatches, rasterSubPatch, PatchCache, blitPatch } = require('./elements');

const ASSET_DIR = path.join(__dirname, '..', '..', 'assets');

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function hexToRgb(s) {
  if (!s) return [0, 0, 0];
  const h = s[0] === '#' ? s.slice(1) : s;
  if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  if (h.length === 3) return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  return [0, 0, 0];
}
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }

const NOISE_CACHE = new Map();
function noiseFields(seed, freqs) {
  const key = seed + ':' + freqs.join(',');
  let v = NOISE_CACHE.get(key);
  if (!v) { v = freqs.map(f => new NoiseField(seed, f)); NOISE_CACHE.set(key, v); }
  return v;
}

// Paint one texture element into a surface covering `rect`, per pixel.
// Values are quantized to the 1/Q grid so they are byte-stable for any tile.
function paintTexture(surface, el, rect, docW, docH) {
  const W = surface.w, H = surface.h;
  const d = surface.data;
  const c1 = hexToRgb(el.colors[0]), c2 = hexToRgb(el.colors[1]), acc = hexToRgb(el.accent || el.colors[1]);
  const f = el.freq || 0.0016;
  const seed = el.seed | 0;
  const fields = noiseFields(seed, [f, f * 2.7, f * 0.55]);
  const dotStep = el.dotStep || 0, dotRadius = el.dotRadius || 0;
  const dotColor = hexToRgb(el.dotColor || '#ffffff');
  const grainAmt = el.grain == null ? 0 : el.grain;
  const bandCount = el.bands || 0;
  const vertical = el.gradient === 'vertical';
  const planes = [new Float32Array(W), new Float32Array(W), new Float32Array(W)];
  const er = el.rect || { x: 0, y: 0, w: docW, h: docH };

  for (let y = 0; y < H; y++) {
    const dy = rect.y0 + y;
    if (dy < er.y || dy >= er.y + er.h) continue;
    fields.forEach((fl, k) => fl.rowInto(dy, rect.x0, W, planes[k]));
    for (let x = 0; x < W; x++) {
      const dx = rect.x0 + x;
      if (dx < er.x || dx >= er.x + er.w) continue;
      const n = planes[0][x] * 0.62 + planes[1][x] * 0.26 + planes[2][x] * 0.12;
      const g = vertical ? dy / docH : dx / docW;
      let col = mix(c1, c2, clamp(g * 0.9 + (n - 0.5) * (el.contrast || 0.7) + 0.05, 0, 1));
      const accentMix = Math.pow(clamp((n - 0.52) * 2.4, 0, 1), 1.6);
      col = mix(col, acc, accentMix * (el.accentStrength == null ? 0.55 : el.accentStrength));
      if (dotStep > 0) {
        const modX = ((dx % dotStep) + dotStep) % dotStep - dotStep / 2;
        const modY = ((dy % dotStep) + dotStep) % dotStep - dotStep / 2;
        const dist = Math.hypot(modX, modY) / dotRadius;
        if (dist < 1) {
          const a = Math.pow(1 - dist, 1.6) * (el.dotStrength == null ? 0.5 : el.dotStrength);
          col = mix(col, dotColor, a);
        }
      }
      if (bandCount > 0) {
        const band = Math.sin(dy * Math.PI * 2 * bandCount / docH);
        col = mix(col, band > 0 ? c2 : c1, Math.abs(band) * 0.10);
      }
      if (grainAmt > 0) {
        const gr = (hash2(dx, dy, seed ^ 0x9e3779b9) - 0.5) * grainAmt * 255;
        col = [col[0] + gr, col[1] + gr, col[2] + gr];
      }
      const o = (y * W + x) * 4;
      d[o] = Math.round(clamp(col[0], 0, 255) / 255 * Q) / Q;
      d[o + 1] = Math.round(clamp(col[1], 0, 255) / 255 * Q) / Q;
      d[o + 2] = Math.round(clamp(col[2], 0, 255) / 255 * Q) / Q;
      d[o + 3] = 1;
    }
  }
}

// Element patches: sub-patch grid per element, keyed by element spec.
let PATCH_CACHE = null;
function setPatchCache(pc) { PATCH_CACHE = pc; }
function getPatchCache() { return PATCH_CACHE; }

function elementPatchBounds(scene, el) {
  const b = elementBounds(el);
  return {
    x0: Math.floor(b.x0) - 10, y0: Math.floor(b.y0) - 10,
    x1: Math.ceil(b.x1) + 10, y1: Math.ceil(b.y1) + 10,
  };
}

// Renders one document rect into a premultiplied surface.
// Texture is painted per pixel; then each element's sub-patches are blitted in
// scene order. A tile only reads the sub-patches it overlaps.
function renderContent(scene, rect) {
  const w = rect.x1 - rect.x0, h = rect.y1 - rect.y0;
  if (w <= 0 || h <= 0) throw new Error('empty content rect');
  if (!PATCH_CACHE) throw new Error('patch cache not configured');
  const surf = createSurface(w, h);

  scene.elements.forEach((el, i) => {
    if (el.type === 'texture') paintTexture(surf, el, rect, scene.width, scene.height);
  });

  scene.elements.forEach((el, i) => {
    if (el.type === 'texture') return;
    const b = elementPatchBounds(scene, el);
    if (b.x1 <= rect.x0 || b.x0 >= rect.x1 || b.y1 <= rect.y0 || b.y0 >= rect.y1) return;
    for (const sp of subPatches(el, scene.width, scene.height)) {
      if (sp.x1 <= rect.x0 || sp.x0 >= rect.x1 || sp.y1 <= rect.y0 || sp.y0 >= rect.y1) continue;
      const key = PATCH_CACHE.keyOf(scene.id, i, el, sp);
      let patch = PATCH_CACHE.get(key);
      if (!patch) {
        patch = rasterSubPatch(el, sp);
        PATCH_CACHE.store(key, patch);
      }
      blitPatch(surf, patch, patch.x0 - rect.x0, patch.y0 - rect.y0);
    }
  });
  return surf;
}

// ---- scenes ----

function auroraScene(docW, docH) {
  const W = docW, H = docH;
  const u = Math.min(W, H);
  const els = [];
  els.push({
    type: 'texture', id: 'bg',
    rect: { x: 0, y: 0, w: W, h: H },
    colors: ['#07101f', '#12364e'], accent: '#2fb6a3',
    freq: 0.0017, contrast: 0.75, accentStrength: 0.45,
    dotStep: 42, dotRadius: 15, dotStrength: 0.10, dotColor: '#d8fff4',
    grain: 0.05, bands: 5, vertical: true, seed: 1109,
  });
  const cx = W * 0.68, cy = H * 0.44;
  els.push({ type: 'circle', id: 'halo', cx, cy, r: u * 0.34, glow: ['rgba(90,230,205,0.45)', 'rgba(20,60,90,0)'] });
  els.push({ type: 'ring', id: 'ring1', cx, cy, r: u * 0.205, width: Math.max(2, u * 0.006), color: '#e8fff8', opacity: 0.55 });
  els.push({ type: 'ring', id: 'ring2', cx, cy, r: u * 0.255, width: Math.max(1, u * 0.002), color: '#7ff0d2', opacity: 0.35 });
  els.push({
    type: 'star', id: 'star', cx: W * 0.17, cy: H * 0.26,
    points: 7, outer: u * 0.095, inner: u * 0.042, rot: 0.3,
    color: '#ffd76a', opacity: 0.92, stroke: '#fff4c9', lineWidth: Math.max(1, u * 0.0022),
  });
  els.push({
    type: 'polygon', id: 'slab',
    points: [[W * 0.06, H * 0.62], [W * 0.42, H * 0.57], [W * 0.46, H * 0.72], [W * 0.10, H * 0.79]],
    color: 'rgba(9,22,34,0.72)',
  });
  els.push({ type: 'sprite', id: 'orb', asset: 'orb', x: W * 0.68, y: H * 0.44, w: u * 0.30, rotate: -0.12, opacity: 0.96 });
  els.push({ type: 'sprite', id: 'gem', asset: 'gem', x: W * 0.83, y: H * 0.68, w: u * 0.17, rotate: 0.35, opacity: 0.9 });
  els.push({ type: 'sprite', id: 'ribbon', asset: 'ribbon', x: W * 0.33, y: H * 0.86, w: u * 0.36, rotate: -0.28, opacity: 0.9 });
  const title = Math.round(u * 0.115);
  els.push({ type: 'text', id: 'title', text: 'AURORA', x: W * 0.055, y: H * 0.30, size: title, weight: 700, color: '#f4fffb', opacity: 0.97 });
  els.push({ type: 'text', id: 'title2', text: 'GRID', x: W * 0.055, y: H * 0.30 + title * 0.92, size: title, weight: 700, color: '#8ff3da' });
  els.push({ type: 'text', id: 'kicker', text: 'TILED  /  SEAMLESS  /  UNBOUNDED', x: W * 0.058, y: H * 0.30 - title * 0.62, size: Math.round(u * 0.024), weight: 400, color: '#9fe8d8', opacity: 0.9 });
  els.push({ type: 'text', id: 'sub', text: 'VECTOR + TRANSPARENT SPRITES + PROCEDURAL TEXTURE', x: W * 0.058, y: H * 0.95, size: Math.round(u * 0.021), weight: 400, color: '#c9e6e2', opacity: 0.8 });
  return { id: 'aurora', width: W, height: H, elements: els };
}

function gridScene(docW, docH) {
  const W = docW, H = docH, u = Math.min(W, H);
  const els = [];
  els.push({
    type: 'texture', id: 'bg',
    rect: { x: 0, y: 0, w: W, h: H },
    colors: ['#1a0f2b', '#08222b'], accent: '#ff7a59',
    freq: 0.0021, contrast: 0.6, accentStrength: 0.5,
    dotStep: 28, dotRadius: 6.5, dotStrength: 0.22, dotColor: '#ffe8c9',
    grain: 0.035, bands: 9, seed: 7717,
  });
  els.push({ type: 'circle', id: 'sun', cx: W * 0.76, cy: H * 0.30, r: u * 0.20, glow: ['rgba(255,150,90,0.55)', 'rgba(80,10,30,0)'] });
  for (let i = 0; i < 5; i++) {
    els.push({ type: 'ring', id: 'orbit' + i, cx: W * 0.76, cy: H * 0.30, r: u * (0.24 + i * 0.045), width: Math.max(1, u * 0.0018), color: '#ffd7a1', opacity: 0.20 - i * 0.025 });
  }
  els.push({ type: 'sprite', id: 'orb', asset: 'orb', x: W * 0.20, y: H * 0.62, w: u * 0.33, rotate: 0.2 });
  els.push({ type: 'sprite', id: 'gem', asset: 'gem', x: W * 0.71, y: H * 0.66, w: u * 0.22, rotate: -0.4 });
  els.push({ type: 'sprite', id: 'ribbon', asset: 'ribbon', x: W * 0.50, y: H * 0.88, w: u * 0.42, rotate: 0.12, opacity: 0.85 });
  const t = Math.round(u * 0.10);
  els.push({ type: 'text', id: 'title', text: 'SUPERSCALE', x: W * 0.06, y: H * 0.22, size: t, weight: 700, color: '#fff3e3' });
  els.push({ type: 'text', id: 'sub', text: 'NO SEAM  /  NO PATTERN RESTART', x: W * 0.063, y: H * 0.22 + t * 0.85, size: Math.round(u * 0.026), weight: 400, color: '#ffcf9e' });
  els.push({ type: 'text', id: 'foot', text: 'TILE SIZE CHANGES ONLY THE GRID - NOT THE IMAGE', x: W * 0.063, y: H * 0.95, size: Math.round(u * 0.019), weight: 400, color: '#f4d9c4', opacity: 0.75 });
  return { id: 'grid', width: W, height: H, elements: els };
}

const SCENE_BUILDERS = { aurora: auroraScene, grid: gridScene };
const ASSETS = { orb: 'orb.png', gem: 'gem.png', ribbon: 'ribbon.png' };

module.exports = {
  auroraScene, gridScene, SCENE_BUILDERS, ASSETS, preloadSprites,
  renderContent, paintTexture, elementPatchBounds, setPatchCache, getPatchCache,
  ASSET_DIR, PatchCache,
};
