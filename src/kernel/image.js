'use strict';
// Premultiplied-alpha float surfaces. Blur + sampling are deterministic and
// tile-independent: values are exact multiples of 2^-16, sums are computed in
// float64, so any output pixel equals the same fixed-order sum no matter which
// tile requested it or how much halo surrounds it.

const Q = 65536;

function createSurface(w, h) {
  return { w, h, data: new Float32Array(w * h * 4) };
}

function fromRGBA8(w, h, buf) {
  const s = createSurface(w, h);
  const d = s.data;
  for (let i = 0, n = w * h * 4; i < n; i += 4) {
    const a = buf[i + 3] / 255;
    d[i] = buf[i] / 255 * a;
    d[i + 1] = buf[i + 1] / 255 * a;
    d[i + 2] = buf[i + 2] / 255 * a;
    d[i + 3] = a;
  }
  return s;
}

function toRGBA8(s) {
  const out = Buffer.allocUnsafe(s.w * s.h * 4);
  const d = s.data;
  for (let i = 0, n = s.w * s.h * 4; i < n; i += 4) {
    const a = d[i + 3];
    if (!(a > 0)) { out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0; continue; }
    const ac = a > 1 ? 1 : a;
    const inv = 255 / ac;
    const r = Math.round(d[i] * inv);
    const g = Math.round(d[i + 1] * inv);
    const b = Math.round(d[i + 2] * inv);
    out[i] = r > 255 ? 255 : r;
    out[i + 1] = g > 255 ? 255 : g;
    out[i + 2] = b > 255 ? 255 : b;
    out[i + 3] = Math.round(ac * 255);
  }
  return out;
}

function over(dst, src) {
  const d = dst.data, s = src.data;
  const n = Math.min(d.length, s.length);
  for (let i = 0; i < n; i += 4) {
    const sa = s[i + 3];
    if (sa <= 0) continue;
    const ia = 1 - sa;
    d[i] = s[i] + d[i] * ia;
    d[i + 1] = s[i + 1] + d[i + 1] * ia;
    d[i + 2] = s[i + 2] + d[i + 2] * ia;
    d[i + 3] = sa + d[i + 3] * ia;
  }
}

function fillSurface(s, r, g, b, a) {
  const d = s.data;
  const pr = r * a, pg = g * a, pb = b * a;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = pr; d[i + 1] = pg; d[i + 2] = pb; d[i + 3] = a;
  }
}

function copySurface(s) {
  return { w: s.w, h: s.h, data: new Float32Array(s.data) };
}

function sampleNearest(s, x, y, out) {
  let xi = Math.floor(x), yi = Math.floor(y);
  if (xi < 0) xi = 0; if (yi < 0) yi = 0;
  if (xi > s.w - 1) xi = s.w - 1; if (yi > s.h - 1) yi = s.h - 1;
  const o = (yi * s.w + xi) * 4;
  out[0] = s.data[o]; out[1] = s.data[o + 1]; out[2] = s.data[o + 2]; out[3] = s.data[o + 3];
  return out;
}

const CR = (t) => {
  const t2 = t * t, t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) * 0.5, (3 * t3 - 5 * t2 + 2) * 0.5, (-3 * t3 + 4 * t2 + t) * 0.5, (t3 - t2) * 0.5];
};

// Catmull-Rom bicubic. Outside the surface counts as transparent.
function sampleBicubic(s, x, y, out) {
  const fx = x - 0.5, fy = y - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  const wx = CR(fx - ix), wy = CR(fy - iy);
  let r = 0, g = 0, b = 0, a = 0;
  const d = s.data, W = s.w, H = s.h;
  for (let j = 0; j < 4; j++) {
    const sy = iy - 1 + j;
    if (sy < 0 || sy >= H) continue;
    let rr = 0, gg = 0, bb = 0, aa = 0;
    for (let i = 0; i < 4; i++) {
      const sx = ix - 1 + i;
      if (sx < 0 || sx >= W) continue;
      const o = (sy * W + sx) * 4;
      rr += d[o] * wx[i]; gg += d[o + 1] * wx[i]; bb += d[o + 2] * wx[i]; aa += d[o + 3] * wx[i];
    }
    r += rr * wy[j]; g += gg * wy[j]; b += bb * wy[j]; a += aa * wy[j];
  }
  out[0] = r < 0 ? 0 : r; out[1] = g < 0 ? 0 : g; out[2] = b < 0 ? 0 : b; out[3] = a < 0 ? 0 : a;
  return out;
}

// ---- blur: three box passes per axis, fixed-point integer sums ----

function boxRadiusForSigma(sigma) {
  if (!(sigma > 0)) return 0;
  const w = Math.sqrt(4 * sigma * sigma + 1);
  return Math.max(1, Math.round((w - 1) / 2));
}

function blurSupportForSigma(sigma) {
  return 3 * boxRadiusForSigma(sigma);
}

function quantize(v, min, max) {
  let q = Math.round(v * Q);
  if (q < 0) q = 0;
  else if (q > Q) q = Q;
  return q;
}

// Horizontal box pass, 4 channels, zero-padded. Output is quantized to 1/Q.
// Zero padding (not clamp) makes the operator a pure function of the content:
// the same document pixel yields the same value for any tile and any halo.
function boxPassH(src, dst, w, h, r) {
  const s = src.data, d = dst.data;
  const p0 = new Float64Array(w + 1), p1 = new Float64Array(w + 1);
  const p2 = new Float64Array(w + 1), p3 = new Float64Array(w + 1);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    p0[0] = p1[0] = p2[0] = p3[0] = 0;
    for (let x = 0; x < w; x++) {
      const o = row + x * 4;
      p0[x + 1] = p0[x] + s[o] * Q;
      p1[x + 1] = p1[x] + s[o + 1] * Q;
      p2[x + 1] = p2[x] + s[o + 2] * Q;
      p3[x + 1] = p3[x] + s[o + 3] * Q;
    }
    for (let x = 0; x < w; x++) {
      let lo = x - r, hi = x + r;
      if (lo < 0) lo = 0; else if (lo > w) lo = w;
      if (hi > w - 1) hi = w - 1;
      const o = row + x * 4;
      d[o] = quantize((p0[hi + 1] - p0[lo]) / (win * Q), 0, 1) / Q;
      d[o + 1] = quantize((p1[hi + 1] - p1[lo]) / (win * Q), 0, 1) / Q;
      d[o + 2] = quantize((p2[hi + 1] - p2[lo]) / (win * Q), 0, 1) / Q;
      d[o + 3] = quantize((p3[hi + 1] - p3[lo]) / (win * Q), 0, 1) / Q;
    }
  }
}

function boxPassV(src, dst, w, h, r) {
  const s = src.data, d = dst.data;
  const p0 = new Float64Array(h + 1), p1 = new Float64Array(h + 1);
  const p2 = new Float64Array(h + 1), p3 = new Float64Array(h + 1);
  const win = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    p0[0] = p1[0] = p2[0] = p3[0] = 0;
    for (let y = 0; y < h; y++) {
      const o = (y * w + x) * 4;
      p0[y + 1] = p0[y] + s[o] * Q;
      p1[y + 1] = p1[y] + s[o + 1] * Q;
      p2[y + 1] = p2[y] + s[o + 2] * Q;
      p3[y + 1] = p3[y] + s[o + 3] * Q;
    }
    for (let y = 0; y < h; y++) {
      let lo = y - r, hi = y + r;
      if (lo < 0) lo = 0; else if (lo > h) lo = h;
      if (hi > h - 1) hi = h - 1;
      const o = (y * w + x) * 4;
      d[o] = quantize((p0[hi + 1] - p0[lo]) / (win * Q), 0, 1) / Q;
      d[o + 1] = quantize((p1[hi + 1] - p1[lo]) / (win * Q), 0, 1) / Q;
      d[o + 2] = quantize((p2[hi + 1] - p2[lo]) / (win * Q), 0, 1) / Q;
      d[o + 3] = quantize((p3[hi + 1] - p3[lo]) / (win * Q), 0, 1) / Q;
    }
  }
}

function blurSurface(src, sigma) {
  const r = boxRadiusForSigma(sigma);
  if (r <= 0) return copySurface(src);
  let a = copySurface(src);
  const b = createSurface(src.w, src.h);
  for (let p = 0; p < 3; p++) {
    boxPassH(a, b, src.w, src.h, r);
    boxPassV(b, a, src.w, src.h, r);
  }
  return a;
}

// Row/column prefix sums accumulate in float64; a quantized input therefore
// produces the exact same fixed-window sum for any tile and any halo.
function blurMask(mask, w, h, sigma) {
  const r = boxRadiusForSigma(sigma);
  if (r <= 0) return Float32Array.from(mask);
  let a = Float32Array.from(mask);
  const b = new Float32Array(w * h);
  const win = 2 * r + 1;
  const rowP = new Float64Array(w + 1), colP = new Float64Array(h + 1);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      rowP[0] = 0;
      for (let x = 0; x < w; x++) rowP[x + 1] = rowP[x] + a[row + x] * Q;
      for (let x = 0; x < w; x++) {
        let lo = x - r, hi = x + r;
        if (lo < 0) lo = 0; else if (lo > w) lo = w;
        if (hi > w - 1) hi = w - 1;
        b[row + x] = quantize((rowP[hi + 1] - rowP[lo]) / (win * Q), 0, 1) / Q;
      }
    }
    for (let x = 0; x < w; x++) {
      colP[0] = 0;
      for (let y = 0; y < h; y++) colP[y + 1] = colP[y] + b[y * w + x] * Q;
      for (let y = 0; y < h; y++) {
        let lo = y - r, hi = y + r;
        if (lo < 0) lo = 0; else if (lo > h) lo = h;
        if (hi > h - 1) hi = h - 1;
        a[y * w + x] = quantize((colP[hi + 1] - colP[lo]) / (win * Q), 0, 1) / Q;
      }
    }
  }
  return a;
}

function dilateMask(mask, w, h, r) {
  if (r <= 0) return Float32Array.from(mask);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) { const v = mask[y * w + k]; if (v > m) m = v; }
      tmp[y * w + x] = m;
    }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = y0; k <= y1; k++) { const v = tmp[k * w + x]; if (v > m) m = v; }
      out[y * w + x] = m;
    }
  }
  return out;
}

// Quantize a surface in place to the 1/Q grid used by every filter output, so
// cached tiles compare bit-exactly across runs.
function quantizeSurface(s) {
  const d = s.data;
  for (let i = 0; i < d.length; i++) d[i] = quantize(d[i], 0, 1) / Q;
  return s;
}

function quantizeMask(m) {
  for (let i = 0; i < m.length; i++) m[i] = quantize(m[i], 0, 1) / Q;
  return m;
}

function cropSurface(s, x0, y0, w, h) {  const out = createSurface(w, h);
  const d = out.data, src = s.data;
  for (let y = 0; y < h; y++) {
    const sy = y + y0;
    if (sy < 0 || sy >= s.h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x + x0;
      if (sx < 0 || sx >= s.w) continue;
      const si = (sy * s.w + sx) * 4, di = (y * w + x) * 4;
      d[di] = src[si]; d[di + 1] = src[si + 1]; d[di + 2] = src[si + 2]; d[di + 3] = src[si + 3];
    }
  }
  return out;
}

module.exports = {
  createSurface, fromRGBA8, toRGBA8, over, fillSurface, copySurface,
  sampleNearest, sampleBicubic, blurSurface, blurMask, dilateMask,
  cropSurface, boxRadiusForSigma, blurSupportForSigma, Q,
  quantizeSurface, quantizeMask, quantize,
};
