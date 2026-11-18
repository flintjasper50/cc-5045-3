'use strict';
// Generates deterministic transparent PNG sprites used by the sample posters.
const fs = require('fs');
const path = require('path');
const { encodePng } = require('../src/kernel/png');

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

function blendPixel(c, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const o = (y * c.w + x) * 4;
  const sa = Math.min(1, a);
  const da = c.data[o + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) return;
  for (let i = 0; i < 3; i++) {
    const sc = [r, g, b][i];
    const dc = c.data[o + i];
    c.data[o + i] = Math.round((sc * sa + dc * da * (1 - sa)) / oa);
  }
  c.data[o + 3] = Math.round(oa * 255);
}

function hex(s) {
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}

function lerp(a, b, t) { return a + (b - a) * t; }

function orb() {
  const w = 512, h = 512, c = makeCanvas(w, h);
  const cx = 256, cy = 256, R = 208;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy) / R;
      if (d > 1.06) continue;
      const edge = Math.max(0, Math.min(1, (1.02 - d) / 0.06));
      const nx = dx / R, ny = dy / R;
      const light = Math.max(0, -0.55 * nx - 0.7 * ny + 0.35);
      const rim = Math.pow(Math.max(0, 1 - Math.abs(d - 0.86) / 0.2), 2);
      let r = lerp(12, 80, Math.min(1, d * 1.2));
      let g = lerp(150, 226, light);
      let b = lerp(168, 236, light);
      r += rim * 120; g += rim * 30;
      const core = Math.pow(1 - d, 1.4);
      r = lerp(r, 255, core * 0.35); g = lerp(g, 244, core * 0.25); b = lerp(b, 214, core * 0.2);
      blendPixel(c, x, y, Math.min(255, r), Math.min(255, g), Math.min(255, b), edge * (0.75 + 0.25 * core));
    }
  }
  // specular highlight
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - (cx - 72), dy = y + 0.5 - (cy - 86);
      const d = Math.hypot(dx, dy) / 66;
      if (d > 1.2) continue;
      const a = Math.pow(Math.max(0, 1 - d), 2.2) * 0.85;
      blendPixel(c, x, y, 255, 255, 246, a);
    }
  }
  return { name: 'orb.png', ...c };
}

function ribbon() {
  const w = 720, h = 360, c = makeCanvas(w, h);
  const rnd = mulberry32(7);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5;
      const mid = 180 + 52 * Math.sin(px / 105 + 0.4) + 18 * Math.sin(px / 37);
      const half = 52 + 22 * Math.cos(px / 88 + 1.1);
      const dy = Math.abs(y + 0.5 - mid);
      const t = Math.min(1, Math.max(0, (px - 40) / (w - 80)));
      const edge = Math.max(0, Math.min(1, (half - dy) / 2.2));
      if (edge <= 0) continue;
      const fold = 0.5 + 0.5 * Math.sin(px / 60 + y / 120);
      const r = lerp(238, 92, t) * (0.72 + 0.35 * fold);
      const g = lerp(112, 206, t) * (0.72 + 0.3 * fold);
      const b = lerp(88, 214, t) * (0.7 + 0.28 * fold);
      const shimmer = 0.06 * (rnd() - 0.5);
      const endFade = Math.min(1, (px - 40) / 70, (w - 40 - px) / 70);
      blendPixel(c, x, y, Math.min(255, r + shimmer * 255), Math.min(255, g), Math.min(255, b), edge * Math.max(0, endFade) * 0.9);
    }
  }
  return { name: 'ribbon.png', ...c };
}

function gem() {
  const w = 384, h = 384, c = makeCanvas(w, h);
  const cx = 192, cy = 192;
  const pts = [];
  const N = 7;
  for (let i = 0; i < N; i++) {
    const a = -Math.PI / 2 + i * 2 * Math.PI / N;
    const rr = 150 + (i % 2 === 0 ? 14 : -10);
    pts.push([cx + Math.cos(a) * rr * 0.86, cy + Math.sin(a) * rr, a]);
  }
  const inside = (x, y) => {
    let c0 = false;
    for (let i = 0, j = N - 1; i < N; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c0 = !c0;
    }
    return c0;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + 0.5, py = y + 0.5;
      if (!inside(px, py)) continue;
      const dx = (px - cx) / 160, dy = (py - cy) / 175;
      const r = Math.hypot(dx, dy);
      const a = Math.atan2(dy, dx);
      const facet = Math.cos(a * N + 0.5) * 0.5 + 0.5;
      const glint = Math.pow(Math.max(0, 1 - Math.hypot(px - 148, py - 128) / 120), 2);
      let R = lerp(70, 226, facet) + glint * 40;
      let G = lerp(46, 150, facet) + glint * 35;
      let B = lerp(120, 246, facet) + glint * 30;
      R = lerp(R, 255, glint * 0.5); G = lerp(G, 250, glint * 0.5); B = lerp(B, 230, glint * 0.5);
      const edge = 1 - Math.pow(r, 4);
      blendPixel(c, x, y, R, G, B, Math.max(0, Math.min(1, 0.55 + 0.4 * facet)) * Math.max(0, edge) * 0.92);
    }
  }
  // soft outer glow
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inside(x + 0.5, y + 0.5)) continue;
      const d = Math.hypot((x + 0.5 - cx) / 190, (y + 0.5 - cy) / 200);
      if (d >= 1) continue;
      const a = Math.pow(1 - d, 3) * 0.30;
      blendPixel(c, x, y, 148, 160, 255, a);
    }
  }
  return { name: 'gem.png', ...c };
}

function writeSprite(spr) {
  const dir = path.join(__dirname, '..', 'assets');
  fs.mkdirSync(dir, { recursive: true });
  const buf = encodePng(spr.w, spr.h, Buffer.from(spr.data.buffer));
  fs.writeFileSync(path.join(dir, spr.name), buf);
  console.log('wrote', spr.name, spr.w + 'x' + spr.h, buf.length + ' bytes');
}

for (const spr of [orb(), ribbon(), gem()]) writeSprite(spr);
