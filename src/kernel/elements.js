'use strict';
// Local-raster element layer, tiled.
//
// Every vector/text/sprite element is rasterized in fixed-size sub-patches on a
// canvas whose device mapping is `doc - subPatchOrigin`. Sub-patch origins are
// fixed by the element's document bbox grid, never by the render tile, so a
// document pixel is always produced by the same canvas operation and therefore
// gets identical antialiasing regardless of tile size or halo. Sub-patches never
// overlap, so assembling them cannot create a seam.
//
// Memory stays bounded: sub-patches live in an LRU (default 48 MB) backed by
// disk, and a tile only materializes the sub-patches it overlaps.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createCanvas, loadImage } = require('@napi-rs/canvas');

const PATCH = 384;          // sub-patch edge in document pixels
const EDGE_PAD = 10;        // extra canvas margin so glyph/AA extents are not clipped
const SPRITE_CACHE = new Map();
const TEXT_METRICS = new Map();

async function preloadSprites(assets) {
  for (const [id, file] of Object.entries(assets)) {
    if (!SPRITE_CACHE.has(id)) {
      SPRITE_CACHE.set(id, await loadImage(path.join(__dirname, '..', '..', 'assets', file)));
    }
  }
}
function spriteImage(id) {
  const img = SPRITE_CACHE.get(id);
  if (!img) throw new Error('sprite not preloaded: ' + id);
  return img;
}

function measureText(el) {
  const key = [el.text, el.size, el.weight, el.family].join('|');
  if (TEXT_METRICS.has(key)) return TEXT_METRICS.get(key);
  const g = createCanvas(4, 4).getContext('2d');
  g.font = `${el.weight || 700} ${el.size}px ${el.family || 'DejaVu Sans'}`;
  const m = g.measureText(el.text);
  const v = {
    ascent: m.actualBoundingBoxAscent || el.size * 0.8,
    descent: m.actualBoundingBoxDescent || el.size * 0.25,
    left: m.actualBoundingBoxLeft || 0,
    right: m.actualBoundingBoxRight || m.width,
  };
  TEXT_METRICS.set(key, v);
  return v;
}

function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
}

function elementBounds(el) {
  switch (el.type) {
    case 'texture': return null;
    case 'rect': {
      const { x, y, w, h } = el;
      if (!el.rotate) return { x0: x, y0: y, x1: x + w, y1: y + h };
      const cx = x + w / 2, cy = y + h / 2;
      const c = Math.cos(el.rotate), s = Math.sin(el.rotate);
      const p = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]
        .map(([px, py]) => [cx + (px - cx) * c - (py - cy) * s, cy + (px - cx) * s + (py - cy) * c]);
      return bboxOf(p);
    }
    case 'circle': return { x0: el.cx - el.r, y0: el.cy - el.r, x1: el.cx + el.r, y1: el.cy + el.r };
    case 'ring': {
      const lw = el.width / 2;
      return { x0: el.cx - el.r - lw, y0: el.cy - el.r - lw, x1: el.cx + el.r + lw, y1: el.cy + el.r + lw };
    }
    case 'star': {
      const r = el.outer + (el.lineWidth || 0) / 2;
      return { x0: el.cx - r, y0: el.cy - r, x1: el.cx + r, y1: el.cy + r };
    }
    case 'line': {
      const hw = (el.width || 1) / 2;
      return {
        x0: Math.min(el.x0, el.x1) - hw, y0: Math.min(el.y0, el.y1) - hw,
        x1: Math.max(el.x0, el.x1) + hw, y1: Math.max(el.y0, el.y1) + hw,
      };
    }
    case 'polygon': return bboxOf(el.points);
    case 'text': {
      const m = measureText(el), base = el.baseline || 'alphabetic';
      let x0, x1;
      if (el.align === 'center') { x0 = el.x - m.right; x1 = el.x + m.left; }
      else if (el.align === 'right') { x0 = el.x - m.left; x1 = el.x + m.right; }
      else { x0 = el.x - m.left; x1 = el.x + m.right; }
      let y0, y1;
      if (base === 'middle') { y0 = el.y - m.ascent; y1 = el.y + m.descent; }
      else if (base === 'top') { y0 = el.y; y1 = el.y + m.ascent + m.descent; }
      else if (base === 'bottom') { y0 = el.y - m.ascent - m.descent; y1 = el.y; }
      else { y0 = el.y - m.ascent; y1 = el.y + m.descent; }
      if (!el.rotate) return { x0, y0, x1, y1 };
      const c = Math.cos(el.rotate), s = Math.sin(el.rotate);
      const p = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]
        .map(([px, py]) => [el.x + (px - el.x) * c - (py - el.y) * s, el.y + (px - el.x) * s + (py - el.y) * c]);
      return bboxOf(p);
    }
    case 'sprite': {
      const img = spriteImage(el.asset);
      const w = el.w, h = w * (img.height / img.width);
      const half = Math.hypot(w, h) / 2 + 2;
      return { x0: el.x - half, y0: el.y - half, x1: el.x + half, y1: el.y + half };
    }
    default: throw new Error('unknown element type ' + el.type);
  }
}

function drawElementLocal(g, el) {
  switch (el.type) {
    case 'rect': {
      g.save();
      if (el.rotate) {
        g.translate(el.x + el.w / 2, el.y + el.h / 2);
        g.rotate(el.rotate);
        g.translate(-(el.x + el.w / 2), -(el.y + el.h / 2));
      }
      g.fillStyle = el.color;
      g.globalAlpha = el.opacity == null ? 1 : el.opacity;
      if (el.radius) {
        const r = el.radius, x = el.x, y = el.y, w = el.w, h = el.h;
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath(); g.fill();
      } else g.fillRect(el.x, el.y, el.w, el.h);
      if (el.stroke) { g.strokeStyle = el.stroke; g.lineWidth = el.lineWidth || 2; g.strokeRect(el.x, el.y, el.w, el.h); }
      g.restore(); return;
    }
    case 'circle': {
      g.save();
      if (el.glow) {
        const grad = g.createRadialGradient(el.cx, el.cy, 0, el.cx, el.cy, el.r);
        grad.addColorStop(0, el.glow[0]);
        grad.addColorStop(1, el.glow[1]);
        g.fillStyle = grad;
      } else { g.fillStyle = el.color; g.globalAlpha = el.opacity == null ? 1 : el.opacity; }
      g.beginPath(); g.arc(el.cx, el.cy, el.r, 0, Math.PI * 2); g.fill();
      g.restore(); return;
    }
    case 'ring': {
      g.save();
      g.strokeStyle = el.color; g.lineWidth = el.width;
      g.globalAlpha = el.opacity == null ? 1 : el.opacity;
      g.beginPath(); g.arc(el.cx, el.cy, el.r, 0, Math.PI * 2); g.stroke();
      g.restore(); return;
    }
    case 'star': {
      g.save();
      g.fillStyle = el.color;
      g.globalAlpha = el.opacity == null ? 1 : el.opacity;
      g.beginPath();
      const n = el.points || 7;
      for (let i = 0; i < n * 2; i++) {
        const a = (el.rot || 0) + i * Math.PI / n;
        const r = i % 2 === 0 ? el.outer : el.inner;
        const x = el.cx + Math.cos(a) * r, y = el.cy + Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill();
      if (el.stroke) { g.strokeStyle = el.stroke; g.lineWidth = el.lineWidth || 3; g.stroke(); }
      g.restore(); return;
    }
    case 'polygon': {
      g.save();
      g.fillStyle = el.color;
      g.globalAlpha = el.opacity == null ? 1 : el.opacity;
      g.beginPath();
      el.points.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]));
      g.closePath(); g.fill();
      g.restore(); return;
    }
    case 'line': {
      g.save();
      g.strokeStyle = el.color;
      g.lineWidth = el.width || 1;
      g.globalAlpha = el.opacity == null ? 1 : el.opacity;
      g.lineCap = el.cap || 'butt';
      g.beginPath();
      g.moveTo(el.x0, el.y0);
      g.lineTo(el.x1, el.y1);
      g.stroke();
      g.restore(); return;
    }
    case 'text': {
      g.save();
      g.fillStyle = el.color;
      g.globalAlpha = el.opacity == null ? 1 : el.opacity;
      g.font = `${el.weight || 700} ${el.size}px ${el.family || 'DejaVu Sans'}`;
      g.textAlign = el.align || 'left';
      g.textBaseline = el.baseline || 'alphabetic';
      if (el.rotate) { g.translate(el.x, el.y); g.rotate(el.rotate); g.fillText(el.text, 0, 0); }
      else g.fillText(el.text, el.x, el.y);
      g.restore(); return;
    }
    case 'sprite': {
      const img = spriteImage(el.asset);
      g.save();
      g.globalAlpha = el.opacity == null ? 1 : el.opacity;
      g.translate(el.x, el.y);
      g.rotate(el.rotate || 0);
      const w = el.w, h = w * (img.height / img.width);
      g.drawImage(img, -w / 2, -h / 2, w, h);
      g.restore(); return;
    }
    default: throw new Error('unknown element type ' + el.type);
  }
}

// Sub-patch grid for an element: aligned to a doc-space multiple of PATCH so the
// same sub-patch serves every render tile. Cells are clipped to the element bbox
// plus EDGE_PAD.
function subPatches(el, sceneW, sceneH) {
  const b = elementBounds(el);
  if (!b) return [];
  const x0 = Math.floor(b.x0) - EDGE_PAD, y0 = Math.floor(b.y0) - EDGE_PAD;
  const x1 = Math.ceil(b.x1) + EDGE_PAD, y1 = Math.ceil(b.y1) + EDGE_PAD;
  const gx0 = Math.floor(x0 / PATCH), gy0 = Math.floor(y0 / PATCH);
  const gx1 = Math.floor((x1 - 1) / PATCH), gy1 = Math.floor((y1 - 1) / PATCH);
  const out = [];
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const px = gx * PATCH, py = gy * PATCH;
      const cx0 = Math.max(x0, px), cy0 = Math.max(y0, py);
      const cx1 = Math.min(x1, px + PATCH), cy1 = Math.min(y1, py + PATCH);
      if (cx1 <= cx0 || cy1 <= cy0) continue;
      out.push({ gx, gy, x0: cx0, y0: cy0, x1: cx1, y1: cy1 });
    }
  }
  return out;
}

function rasterSubPatch(el, sp) {
  const w = sp.x1 - sp.x0, h = sp.y1 - sp.y0;
  const canvas = createCanvas(w, h);
  const g = canvas.getContext('2d');
  g.translate(-sp.x0, -sp.y0);
  drawElementLocal(g, el);
  const data = g.getImageData(0, 0, w, h).data;
  return { x0: sp.x0, y0: sp.y0, w, h, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength) };
}

// Disk+LRU cache of sub-patches. Key includes the element spec (so any change to
// colour, geometry, text, or sprite assignment invalidates it) and the cell.
class PatchCache {
  constructor(dir, memoryLimitMb = 48) {
    this.dir = dir;
    this.limit = memoryLimitMb * 1048576;
    this.mem = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.peakBytes = 0;
    fs.mkdirSync(dir, { recursive: true });
  }
  keyOf(sceneId, index, el, sp) {
    const spec = crypto.createHash('sha1').update(JSON.stringify([sceneId, el])).digest('hex').slice(0, 16);
    return `${sceneId}-${index}-${spec}-${sp.gx}_${sp.gy}`;
  }
  get(key) {
    const hit = this.mem.get(key);
    if (hit) { this.hits++; this.mem.delete(key); this.mem.set(key, hit); return hit; }
    const file = path.join(this.dir, key + '.patch');
    let buf;
    try { buf = fs.readFileSync(file); } catch (_) { this.misses++; return null; }
    if (buf.length < 16) { this.misses++; return null; }
    const w = buf.readInt32LE(8), h = buf.readInt32LE(12);
    if (w <= 0 || h <= 0 || buf.length !== 16 + w * h * 4) { this.misses++; return null; }
    this.hits++;
    const patch = { x0: buf.readInt32LE(0), y0: buf.readInt32LE(4), w, h, data: buf.subarray(16) };
    this.putMem(key, patch);
    return patch;
  }
  putMem(key, patch) {
    this.mem.set(key, patch);
    this.bytes += patch.data.length;
    if (this.bytes > this.peakBytes) this.peakBytes = this.bytes;
    while (this.bytes > this.limit && this.mem.size > 1) {
      const first = this.mem.keys().next().value;
      const e = this.mem.get(first);
      this.mem.delete(first);
      this.bytes -= e.data.length;
    }
  }
  store(key, patch) {
    const head = Buffer.alloc(16);
    head.writeInt32LE(patch.x0, 0); head.writeInt32LE(patch.y0, 4);
    head.writeInt32LE(patch.w, 8); head.writeInt32LE(patch.h, 12);
    const file = path.join(this.dir, key + '.patch');
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, Buffer.concat([head, patch.data]));
    fs.renameSync(tmp, file);
    this.putMem(key, patch);
  }
  stats() {
    return {
      memoryLimitMb: Math.round(this.limit / 1048576),
      peakMemoryMb: +(this.peakBytes / 1048576).toFixed(1),
      hits: this.hits, misses: this.misses,
    };
  }
}

// Blit a premultiplied RGBA8 patch into a premultiplied Float32 surface.
function blitPatch(dst, patch, dx, dy) {
  const sx0 = Math.max(0, -dx), sy0 = Math.max(0, -dy);
  const sx1 = Math.min(patch.w, dst.w - dx), sy1 = Math.min(patch.h, dst.h - dy);
  const d = dst.data, s = patch.data;
  for (let j = sy0; j < sy1; j++) {
    const di = ((dy + j) * dst.w + dx) * 4;
    const si = j * patch.w * 4;
    for (let i = sx0; i < sx1; i++) {
      const o = di + i * 4;
      const sa = s[si + i * 4 + 3];
      if (sa === 0) continue;
      const a = sa / 255;
      const ia = 1 - a;
      d[o] = s[si + i * 4] / 255 * a + d[o] * ia;
      d[o + 1] = s[si + i * 4 + 1] / 255 * a + d[o + 1] * ia;
      d[o + 2] = s[si + i * 4 + 2] / 255 * a + d[o + 2] * ia;
      d[o + 3] = a + d[o + 3] * ia;
    }
  }
}

module.exports = {
  preloadSprites, spriteImage, elementBounds, subPatches, rasterSubPatch,
  PatchCache, blitPatch, drawElementLocal, PATCH, EDGE_PAD,
};
