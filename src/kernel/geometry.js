'use strict';
// Integer half-open rects in document coordinates. All halo/back-propagation
// math lives here; renderers must never invent their own margins.

function rect(x0, y0, x1, y1) { return { x0, y0, x1, y1 }; }
function rw(r) { return r.x1 - r.x0; }
function rh(r) { return r.y1 - r.y0; }
function area(r) { return Math.max(0, rw(r)) * Math.max(0, rh(r)); }
function expand(r, e) { return rect(r.x0 - e, r.y0 - e, r.x1 + e, r.y1 + e); }
function expandXY(r, ex, ey) { return rect(r.x0 - ex, r.y0 - ey, r.x1 + ex, r.y1 + ey); }
function shift(r, dx, dy) { return rect(r.x0 + dx, r.y0 + dy, r.x1 + dx, r.y1 + dy); }
function bbox(a, b) {
  return rect(Math.min(a.x0, b.x0), Math.min(a.y0, b.y0), Math.max(a.x1, b.x1), Math.max(a.y1, b.y1));
}
function union(...rs) { return rs.reduce((a, b) => bbox(a, b)); }
function intersect(a, b) {
  return rect(Math.max(a.x0, b.x0), Math.max(a.y0, b.y0), Math.min(a.x1, b.x1), Math.min(a.y1, b.y1));
}
function intersects(a, b) { return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1; }
function contains(outer, inner) {
  return inner.x0 >= outer.x0 && inner.y0 >= outer.y0 && inner.x1 <= outer.x1 && inner.y1 <= outer.y1;
}
function isEmpty(r) { return r.x1 <= r.x0 || r.y1 <= r.y0; }
function clipTo(r, doc) { return intersect(r, doc); }
function same(a, b) { return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1; }
function toString(r) { return `${r.x0},${r.y0},${r.x1},${r.y1}`; }

// Rotate a point (x,y) by angle radians about (cx,cy).
function rot(x, y, cx, cy, a) {
  const c = Math.cos(a), s = Math.sin(a);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

// Map a doc point from output space to input space for a resample filter.
// Forward: out = C + R(angle) * (in - C) * scale.
function resampleInverse(f, x, y) {
  const a = -(f.angle || 0);
  const dx = (x - f.cx) / f.scale, dy = (y - f.cy) / f.scale;
  const c = Math.cos(a), s = Math.sin(a);
  return [f.cx + dx * c - dy * s, f.cy + dx * s + dy * c];
}

function resampleForward(f, x, y) {
  const [rx, ry] = rot(x - f.cx, y - f.cy, 0, 0, f.angle || 0);
  return [f.cx + rx * f.scale, f.cy + ry * f.scale];
}

function bboxPoints(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  return rect(Math.floor(x0), Math.floor(y0), Math.ceil(x1), Math.ceil(y1));
}

// Filters expose their geometric effect through these two helpers, which are
// kept keyed on filter type so new filters must state halo math explicitly.
function filterSupport(filter) {
  const { blurSupportForSigma } = require('./image');
  switch (filter.type) {
    case 'blur': return blurSupportForSigma(filter.sigma);
    case 'shadow': return blurSupportForSigma(filter.sigma) + Math.ceil(filter.spread);
    case 'resample': return 3;
    default: return 0;
  }
}

function backPropRect(filter, r) {
  switch (filter.type) {
    case 'blur':
      return expand(r, filterSupport(filter));
    case 'shadow': {
      const s = filterSupport(filter);
      return union(r, expand(shift(r, -Math.round(filter.dx), -Math.round(filter.dy)), s));
    }
    case 'resample': {
      const pts = [
        resampleInverse(filter, r.x0, r.y0),
        resampleInverse(filter, r.x1, r.y0),
        resampleInverse(filter, r.x0, r.y1),
        resampleInverse(filter, r.x1, r.y1),
      ];
      return expand(bboxPoints(pts), 3);
    }
    default:
      throw new Error('unknown filter type ' + filter.type);
  }
}

// Backward chain: rects[i] is the input region required to produce rects[i+1].
// rects[0] is the raw content region, rects[n] is the requested output.
function backPropChain(filters, outputRect) {
  const rects = new Array(filters.length + 1);
  rects[filters.length] = outputRect;
  for (let i = filters.length - 1; i >= 0; i--) rects[i] = backPropRect(filters[i], rects[i + 1]);
  return rects;
}

// Where can the filtered output of raw content confined to `contentRect` land?
function outputBoundsChain(filters, contentRect) {
  let r = contentRect;
  for (const f of filters) {
    switch (f.type) {
      case 'blur': r = expand(r, filterSupport(f)); break;
      case 'shadow': {
        const s = filterSupport(f);
        r = union(r, expand(shift(r, Math.round(f.dx), Math.round(f.dy)), s));
        break;
      }
      case 'resample': {
        const pts = [
          resampleForward(f, r.x0, r.y0), resampleForward(f, r.x1, r.y0),
          resampleForward(f, r.x0, r.y1), resampleForward(f, r.x1, r.y1),
        ];
        r = expand(bboxPoints(pts), 3);
        break;
      }
      default: break;
    }
  }
  return r;
}

function makeGrid(docRect, tileW, tileH = tileW) {
  const tiles = [];
  let row = 0;
  for (let y = docRect.y0; y < docRect.y1; y += tileH) {
    let col = 0;
    for (let x = docRect.x0; x < docRect.x1; x += tileW) {
      tiles.push({
        index: tiles.length, row, col,
        crop: rect(x, y, Math.min(x + tileW, docRect.x1), Math.min(y + tileH, docRect.y1)),
      });
      col++;
    }
    row++;
  }
  return { tiles, cols: tiles.length ? tiles[tiles.length - 1].col + 1 : 0, rows: tiles.length ? tiles[tiles.length - 1].row + 1 : 0 };
}

module.exports = {
  rect, rw, rh, area, expand, expandXY, shift, bbox, union, intersect, intersects,
  contains, isEmpty, clipTo, same, toString, rot, resampleInverse, resampleForward,
  bboxPoints, filterSupport, backPropRect, backPropChain, outputBoundsChain, makeGrid,
};
