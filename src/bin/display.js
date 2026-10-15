// Custom Display: a media player entity whose picture (media_image_url) and text lines are drawn by
// this integration. EXPERIMENT: checks whether the remote's media widget shows an image served by the
// integration, how it's sized, which buttons reach the integration, and whether it updates live.
//
// Images are drawn with a tiny raster + PNG encoder (no native modules on the remote).

import zlib from "node:zlib";

// ---- PNG encoding ---------------------------------------------------------------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** RGBA raster -> PNG buffer. */
export function encodePng(r) {
  const rows = Buffer.alloc((r.w * 4 + 1) * r.h);
  for (let y = 0; y < r.h; y++) {
    rows[y * (r.w * 4 + 1)] = 0;
    r.px.copy(rows, y * (r.w * 4 + 1) + 1, y * r.w * 4, (y + 1) * r.w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(r.w, 0);
  ihdr.writeUInt32BE(r.h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows, { level: 6 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---- tiny raster ------------------------------------------------------------------
export function raster(w, h, bg = [0, 0, 0, 255]) {
  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(bg, i * 4);
  return { w, h, px };
}
function blend(r, x, y, c, a = 1) {
  if (x < 0 || y < 0 || x >= r.w || y >= r.h) return;
  const i = (y * r.w + x) * 4;
  const k = a * (c[3] ?? 255) / 255;
  for (let j = 0; j < 3; j++) r.px[i + j] = Math.round(r.px[i + j] * (1 - k) + c[j] * k);
  r.px[i + 3] = Math.max(r.px[i + 3], Math.round(255 * k));
}
export function fillRect(r, x, y, w, h, c) {
  for (let yy = Math.max(0, y | 0); yy < Math.min(r.h, (y + h) | 0); yy++) for (let xx = Math.max(0, x | 0); xx < Math.min(r.w, (x + w) | 0); xx++) blend(r, xx, yy, c);
}
/** Anti-aliased ring segment from angle a0 to a1 (radians, 0 = up, clockwise). */
export function ring(r, cx, cy, rad, width, a0, a1, c) {
  const ro = rad + width / 2, ri = rad - width / 2;
  for (let y = Math.floor(cy - ro - 1); y <= cy + ro + 1; y++) {
    for (let x = Math.floor(cx - ro - 1); x <= cx + ro + 1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const d = Math.hypot(dx, dy);
      const cover = Math.min(1, Math.max(0, ro - d + 0.5)) * Math.min(1, Math.max(0, d - ri + 0.5));
      if (cover <= 0) continue;
      let a = Math.atan2(dx, -dy);
      if (a < 0) a += Math.PI * 2;
      if (a < a0 || a > a1) continue;
      blend(r, x, y, c, cover);
    }
  }
}
// 7-segment digits: segments a b c d e f g
const SEG = { 0: "abcdef", 1: "bc", 2: "abged", 3: "abgcd", 4: "fgbc", 5: "afgcd", 6: "afgedc", 7: "abc", 8: "abcdefg", 9: "abcdfg", "-": "g" };
export function digits(r, text, x, y, h, c) {
  const w = h * 0.55, t = Math.max(3, h * 0.12), gap = h * 0.18;
  for (const ch of String(text)) {
    const s = SEG[ch] || "";
    const H = h / 2;
    const seg = {
      a: [x + t, y, w - 2 * t, t], d: [x + t, y + h - t, w - 2 * t, t], g: [x + t, y + H - t / 2, w - 2 * t, t],
      f: [x, y + t, t, H - t], b: [x + w - t, y + t, t, H - t], e: [x, y + H, t, H - t], c: [x + w - t, y + H, t, H - t]
    };
    for (const k of s) fillRect(r, ...seg[k], c);
    x += w + gap;
  }
}
const hsv = (h, s, v) => {
  const f = (n) => { const k = (n + h / 60) % 6; return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)))); };
  return [f(5), f(3), f(1), 255];
};

/** Test picture: color changes each tick, a ring shows seconds, big counter, corner marks show cropping. */
export function testImage(n, size = 400) {
  const r = raster(size, size, hsv((n * 37) % 360, 0.55, 0.35));
  const white = [255, 255, 255, 255];
  ring(r, size / 2, size / 2, size * 0.36, size * 0.06, 0, Math.PI * 2, [255, 255, 255, 60]);
  ring(r, size / 2, size / 2, size * 0.36, size * 0.06, 0, ((n % 20) / 20) * Math.PI * 2 + 0.001, white);
  const text = String(n % 1000);
  const h = size * 0.28, w = h * 0.55, gap = h * 0.18;
  digits(r, text, size / 2 - (text.length * (w + gap) - gap) / 2, size / 2 - h / 2, h, white);
  // corner and edge marks: if the widget crops, some of these disappear
  const m = size * 0.06;
  for (const [x, y] of [[0, 0], [size - m, 0], [0, size - m], [size - m, size - m]]) fillRect(r, x, y, m, m, [255, 220, 0, 255]);
  for (const [x, y] of [[size / 2 - m / 2, 0], [size / 2 - m / 2, size - m], [0, size / 2 - m / 2], [size - m, size / 2 - m / 2]]) fillRect(r, x, y, m, m, [0, 200, 255, 255]);
  return encodePng(r);
}
