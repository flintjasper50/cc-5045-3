'use strict';
// Deterministic hashing + full-image coordinate noise. All randomness is
// addressed by absolute document coordinates, never by tile-local ones.

const crypto = require('crypto');

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

function hashOf(obj, hexLen = 32) {
  return crypto.createHash('sha256').update(stableStringify(obj)).digest('hex').slice(0, hexLen);
}

function sha256File(file) {
  const fs = require('fs');
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1 << 20);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return h.digest('hex');
}

function hash2(ix, iy, seed) {
  let h = Math.imul(ix | 0, 374761393) + Math.imul(iy | 0, 668265263) + Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smootherstep(t) { return t * t * t * (t * (t * 6 - 15) + 10); }

function valueNoise(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = smootherstep(x - x0), ty = smootherstep(y - y0);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  const ab = a + (b - a) * tx;
  const cd = c + (d - c) * tx;
  return ab + (cd - ab) * ty;
}

function fbm(x, y, seed, octaves = 3) {
  let sum = 0, amp = 0.5, norm = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * f, y * f, seed + i * 1013) * amp;
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

function grain(x, y, seed) {
  return hash2(Math.floor(x), Math.floor(y), seed ^ 0x5bd1e995);
}

// Row-incremental 2D value noise over a rect. Returns a function producing the
// noise value per pixel; lattice hashes are computed once per cell row/column.
class NoiseField {
  constructor(seed, freq) {
    this.seed = seed | 0;
    this.freq = freq;
  }
  // For a tile row at doc y, fill plane[0..w-1] with interpolated noise.
  rowInto(y, x0, w, plane, seedOffset = 0) {
    const f = this.freq;
    const fy = y * f;
    const y0 = Math.floor(fy);
    const ty = smootherstep(fy - y0);
    const sd = this.seed + seedOffset;
    let px = NaN, a = 0, b = 0, c = 0, d = 0;
    for (let i = 0; i < w; i++) {
      const fx = (x0 + i) * f;
      const x0i = Math.floor(fx);
      if (x0i !== px) {
        px = x0i;
        a = hash2(x0i, y0, sd); b = hash2(x0i + 1, y0, sd);
        c = hash2(x0i, y0 + 1, sd); d = hash2(x0i + 1, y0 + 1, sd);
      }
      const tx = smootherstep(fx - x0i);
      const ab = a + (b - a) * tx;
      const cd = c + (d - c) * tx;
      plane[i] = ab + (cd - ab) * ty;
    }
  }
}

module.exports = { stableStringify, hashOf, sha256File, hash2, valueNoise, fbm, grain, NoiseField, smootherstep };
