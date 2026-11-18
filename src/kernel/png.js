'use strict';
// PNG encode/decode in pure Node. RGBA8, non-premultiplied storage.
const zlib = require('zlib');
const fs = require('fs');

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf, start = 0, end = buf.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Raw filter bytes for one scanline, choosing the filter with the smallest sum of abs values.
function filterScanline(cur, prev, bpp, out, outOff, forcedFilter) {
  const n = cur.length;
  const candidates = forcedFilter == null ? [0, 1, 2, 3, 4] : [forcedFilter];
  let bestFilter = 0, bestScore = Infinity, bestBuf = null;
  const tmp = Buffer.allocUnsafe(n);
  for (const f of candidates) {
    let score = 0;
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (f === 0) v = cur[i];
      else if (f === 1) v = cur[i] - a;
      else if (f === 2) v = cur[i] - b;
      else if (f === 3) v = cur[i] - ((a + b) >> 1);
      else v = cur[i] - paeth(a, b, c);
      v &= 0xff;
      tmp[i] = v;
      score += v < 128 ? v : 256 - v;
    }
    if (score < bestScore) {
      bestScore = score; bestFilter = f; bestBuf = Buffer.from(tmp);
      if (forcedFilter != null) break;
      if (score === 0) break;
    }
  }
  out[outOff] = bestFilter;
  bestBuf.copy(out, outOff + 1);
}

class PngWriter {
  constructor(file, width, height, opts = {}) {
    this.file = file;
    this.width = width;
    this.height = height;
    this.level = opts.level == null ? 6 : opts.level;
    this.bpp = 4;
    this.rowsWritten = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.expected = width * height * 4;
    this.prev = null;
    this.bytesIn = 0;
    fs.mkdirSync(require('path').dirname(file), { recursive: true });
    this.fd = fs.openSync(file, 'w');
    fs.writeSync(this.fd, SIGNATURE);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    fs.writeSync(this.fd, chunk('IHDR', ihdr));
  }

  write(buf) {
    if (this.bytesIn + buf.length > this.expected) throw new Error('PngWriter: too much pixel data');
    this.pending.push(buf);
    this.bytesIn += buf.length;
    this.pendingBytes += buf.length;
    if (this.pendingBytes >= 1 << 20) this._flush(false);
  }

  _flush(final) {
    if (!this.pending.length) return;
    const raw = Buffer.concat(this.pending, this.pendingBytes);
    this.pending = []; this.pendingBytes = 0;
    const rowBytes = this.width * this.bpp;
    const avail = Math.floor(raw.length / rowBytes);
    const count = final ? Math.min(avail, this.height - this.rowsWritten) : avail;
    if (count <= 0) return;
    const filtered = Buffer.allocUnsafe(count * (rowBytes + 1));
    for (let r = 0; r < count; r++) {
      const cur = raw.subarray(r * rowBytes, (r + 1) * rowBytes);
      filterScanline(cur, this.prev, this.bpp, filtered, r * (rowBytes + 1), this.level === 0 ? 0 : null);
      this.prev = cur;
    }
    const leftover = raw.subarray(count * rowBytes);
    if (leftover.length) {
      this.pending.push(Buffer.from(leftover));
      this.pendingBytes = leftover.length;
    }
    const deflated = zlib.deflateSync(filtered, { level: this.level });
    fs.writeSync(this.fd, chunk('IDAT', deflated));
    this.rowsWritten += count;
  }

  // Feed a sub-rectangle of this image (used for streaming strip assembly).
  writeRect(x, y, w, h, rgba) {
    const rowBytes = w * 4;
    if (x !== 0 || w !== this.width) throw new Error('PngWriter.writeRect: only full-width strips');
    for (let r = 0; r < h; r++) this.write(rgba.subarray(r * rowBytes, (r + 1) * rowBytes));
    if (y !== this.rowsWritten - h) throw new Error('PngWriter.writeRect: out of order strip');
  }

  end() {
    this._flush(true);
    if (this.rowsWritten !== this.height) {
      fs.closeSync(this.fd);
      throw new Error(`PngWriter: short image ${this.rowsWritten}/${this.height}`);
    }
    fs.writeSync(this.fd, chunk('IEND', Buffer.alloc(0)));
    fs.closeSync(this.fd);
  }
}

function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNG not supported');
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} not supported`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`color type ${colorType} not supported`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    const cur = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = cur[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) v += paeth(a, b, c);
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * channels;
      if (colorType === 6) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = cur[s + 3]; }
      else if (colorType === 2) { out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = 255; }
      else if (colorType === 0) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = 255; }
      else if (colorType === 4) { out[o] = out[o + 1] = out[o + 2] = cur[s]; out[o + 3] = cur[s + 1]; }
      else if (colorType === 3) {
        const idx = cur[s];
        out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev = cur;
  }
  return { width, height, data: out };
}

function encodePng(width, height, rgba) {
  const bpp = 4, rowBytes = width * bpp;
  const filtered = Buffer.allocUnsafe(height * (rowBytes + 1));
  let prev = null;
  for (let y = 0; y < height; y++) {
    const cur = rgba.subarray(y * rowBytes, (y + 1) * rowBytes);
    filterScanline(cur, prev, bpp, filtered, y * (rowBytes + 1), null);
    prev = cur;
  }
  const idat = zlib.deflateSync(filtered, { level: 6 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

module.exports = { PngWriter, decodePng, encodePng, crc32 };
