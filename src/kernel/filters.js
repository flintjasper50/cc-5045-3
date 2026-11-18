'use strict';
// Filter operators. Each filter declares its parameters and its geometric
// support; geometry.js turns that into per-tile halo. The `params` metadata is
// also what drives the UI controls, so kernel and interface cannot drift apart.

const {
  createSurface, copySurface, over, sampleBicubic, blurSurface, blurMask,
  dilateMask, cropSurface, boxRadiusForSigma, blurSupportForSigma,
  quantizeSurface, quantizeMask,
} = require('./image');
const geom = require('./geometry');

const FILTERS = {
  blur: {
    label: '高斯模糊',
    description: '三遍盒式模糊逼近高斯；支撑半径由 σ 推导。',
    params: {
      sigma: { label: 'σ 半径', min: 0, max: 64, step: 0.5, default: 8 },
    },
  },
  shadow: {
    label: '投影阴影',
    description: '对图层 alpha 膨胀 + 模糊后按偏移合成，原图层置顶。',
    params: {
      dx: { label: 'X 偏移', min: -128, max: 128, step: 1, default: 18 },
      dy: { label: 'Y 偏移', min: -128, max: 128, step: 1, default: 24 },
      sigma: { label: 'σ 半径', min: 0.5, max: 48, step: 0.5, default: 10 },
      spread: { label: '膨胀', min: 0, max: 32, step: 1, default: 2 },
      color: { label: '颜色', type: 'color', default: '#000000' },
      opacity: { label: '不透明度', min: 0, max: 1, step: 0.01, default: 0.55 },
    },
  },
  resample: {
    label: '重采样',
    description: '以全图中心为锚点做 Catmull-Rom 双三次缩放/旋转。',
    params: {
      scale: { label: '缩放', min: 0.25, max: 4, step: 0.05, default: 1.15 },
      angle: { label: '旋转°', min: -45, max: 45, step: 0.5, default: 0 },
      cx: { label: '锚点 X (0-1)', min: 0, max: 1, step: 0.01, default: 0.5 },
      cy: { label: '锚点 Y (0-1)', min: 0, max: 1, step: 0.01, default: 0.5 },
    },
  },
};

function normalizeFilter(raw, docW, docH) {
  if (!raw || !FILTERS[raw.type]) throw new Error('未知滤镜: ' + (raw && raw.type));
  const def = FILTERS[raw.type];
  const out = { type: raw.type };
  for (const [k, spec] of Object.entries(def.params)) {
    const v = raw[k] === undefined ? spec.default : raw[k];
    if (spec.type === 'color') {
      if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Error(`滤镜 ${raw.type}.${k} 颜色非法`);
      out[k] = v.toLowerCase();
    } else {
      const n = Number(v);
      if (!Number.isFinite(n)) throw new Error(`滤镜 ${raw.type}.${k} 非法`);
      if (n < spec.min || n > spec.max) throw new Error(`滤镜 ${raw.type}.${k} 超出范围`);
      out[k] = n;
    }
  }
  if (out.type === 'shadow') out.spread = Math.round(out.spread);
  if (out.type === 'resample') {
    out.angle = out.angle * Math.PI / 180;
    out.cx = out.cx * docW;
    out.cy = out.cy * docH;
  }
  return out;
}

function normalizeChain(rawFilters, docW, docH) {
  return (rawFilters || []).map(f => normalizeFilter(f, docW, docH));
}

function hexToRgb(s) {
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
}

// Wrap a surface as a filter object with the support helpers geometry.js needs.
function asFilter(f) {
  return {
    type: f.type,
    sigma: f.sigma,
    spread: f.spread,
    dx: f.dx, dy: f.dy,
    scale: f.scale, angle: f.angle, cx: f.cx, cy: f.cy,
    blurSupport() { return blurSupportForSigma(f.sigma); },
  };
}

// Apply filter `f` to input surface `S` (covering sRect) and return a surface
// covering exactly outRect (document coords). outRect must be inside the output
// bounds implied by geometry.backPropChain.
function applyFilter(f, S, sRect, outRect) {
  const W = outRect.x1 - outRect.x0, H = outRect.y1 - outRect.y0;
  if (W <= 0 || H <= 0) return { surface: createSurface(0, 0), rect: outRect };

  if (f.type === 'blur') {
    const blurred = blurSurface(quantizeSurface(S), f.sigma);
    const surface = cropSurface(blurred, outRect.x0 - sRect.x0, outRect.y0 - sRect.y0, W, H);
    return { surface, rect: outRect };
  }

  if (f.type === 'shadow') {
    const support = blurSupportForSigma(f.sigma) + Math.round(f.spread);
    // The dilated mask at outRect's needed points may draw source alpha up to
    // `spread` away, so the sampled mask region includes spread + blur support.
    const maskRect = geom.expand(geom.shift(geom.expand(outRect, 2), -Math.round(f.dx), -Math.round(f.dy)), support);
    const mw = maskRect.x1 - maskRect.x0, mh = maskRect.y1 - maskRect.y0;
    const mask = new Float32Array(mw * mh);
    // alpha from S, restricted to S bounds
    for (let y = 0; y < mh; y++) {
      const sy = maskRect.y0 + y;
      if (sy < sRect.y0 || sy >= sRect.y1) continue;
      for (let x = 0; x < mw; x++) {
        const sx = maskRect.x0 + x;
        if (sx < sRect.x0 || sx >= sRect.x1) continue;
        mask[y * mw + x] = S.data[((sy - sRect.y0) * S.w + (sx - sRect.x0)) * 4 + 3];
      }
    }
    const spread = Math.round(f.spread);
    let m = spread > 0 ? dilateMask(mask, mw, mh, spread) : mask;
    m = blurMask(quantizeMask(m), mw, mh, f.sigma);
    const col = hexToRgb(f.color);
    const out = createSurface(W, H);
    const od = out.data;
    for (let y = 0; y < H; y++) {
      const dy = outRect.y0 + y;
      for (let x = 0; x < W; x++) {
        const dx = outRect.x0 + x;
        const mx = dx - Math.round(f.dx) - maskRect.x0;
        const my = dy - Math.round(f.dy) - maskRect.y0;
        let a = 0;
        if (mx >= 0 && my >= 0 && mx < mw && my < mh) a = m[my * mw + mx] * f.opacity;
        const o = (y * W + x) * 4;
        od[o] = col[0] / 255 * a; od[o + 1] = col[1] / 255 * a; od[o + 2] = col[2] / 255 * a; od[o + 3] = a;
      }
    }
    // composite original content on top
    for (let y = 0; y < H; y++) {
      const sy = outRect.y0 + y;
      if (sy < sRect.y0 || sy >= sRect.y1) continue;
      for (let x = 0; x < W; x++) {
        const sx = outRect.x0 + x;
        if (sx < sRect.x0 || sx >= sRect.x1) continue;
        const si = ((sy - sRect.y0) * S.w + (sx - sRect.x0)) * 4;
        const o = (y * W + x) * 4;
        const sa = S.data[si + 3];
        if (sa <= 0) continue;
        const ia = 1 - sa;
        od[o] = S.data[si] + od[o] * ia;
        od[o + 1] = S.data[si + 1] + od[o + 1] * ia;
        od[o + 2] = S.data[si + 2] + od[o + 2] * ia;
        od[o + 3] = sa + od[o + 3] * ia;
      }
    }
    return { surface: out, rect: outRect };
  }

  if (f.type === 'resample') {
    const cf = asFilter(f);
    const out = createSurface(W, H);
    const od = out.data;
    const px = [0, 0, 0, 0];
    for (let y = 0; y < H; y++) {
      const dy = outRect.y0 + y;
      for (let x = 0; x < W; x++) {
        const dx = outRect.x0 + x;
        const [ix, iy] = geom.resampleInverse(cf, dx + 0.5, dy + 0.5);
        sampleBicubic(S, ix - sRect.x0, iy - sRect.y0, px);
        const o = (y * W + x) * 4;
        od[o] = px[0]; od[o + 1] = px[1]; od[o + 2] = px[2]; od[o + 3] = px[3];
      }
    }
    return { surface: out, rect: outRect };
  }

  throw new Error('未知滤镜类型: ' + f.type);
}

module.exports = {
  FILTERS, normalizeFilter, normalizeChain, applyFilter, asFilter,
  blurSupportForSigma, boxRadiusForSigma,
};
