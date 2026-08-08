'use strict';
/**
 * Generates build/icon.ico (256x256) with zero image dependencies.
 * The glyph matches the "layers" mark used in the app top bar.
 * ICO files may embed a PNG payload directly, so we only need zlib.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 256;
const BG = [13, 17, 23];        // #0d1117
const RING = [33, 42, 54];      // subtle border
const ACCENT = [88, 166, 255];  // #58a6ff
const ACCENT2 = [63, 185, 80];  // #3fb950

function mix(a, b, t) { return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t)); }

// Signed "inside" test for a diamond centred at (cx,cy) with radii (rx,ry).
function diamond(x, y, cx, cy, rx, ry) { return Math.abs(x - cx) / rx + Math.abs(y - cy) / ry; }

function buildPixels() {
  const px = Buffer.alloc(S * S * 4);
  const r = 52; // corner radius
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;

      // rounded-square background with 1px-ish antialiased edge
      const dx = Math.max(r - x, x - (S - 1 - r), 0);
      const dy = Math.max(r - y, y - (S - 1 - r), 0);
      const d = Math.hypot(dx, dy);
      const inside = r - d;            // >0 inside
      const alpha = Math.max(0, Math.min(1, inside + 0.5));
      if (alpha <= 0) { px[i + 3] = 0; continue; }

      let c = BG;
      // faint inner border
      if (inside < 3 && inside > 0) c = mix(BG, RING, 0.9);

      const cx = S / 2;
      // top diamond
      const dTop = diamond(x, y, cx, 96, 92, 46);
      // two chevrons (lower halves of larger diamonds)
      const dMid = diamond(x, y, cx, 140, 92, 46);
      const dBot = diamond(x, y, cx, 184, 92, 46);

      const band = (dv, cy) => (y >= cy - 2 && dv <= 1 && dv >= 0.72);

      if (dTop <= 1) {
        // shade the top face so it reads as a solid slab
        const t = Math.min(1, Math.max(0, (y - 50) / 92));
        c = mix(ACCENT, mix(ACCENT, ACCENT2, 0.35), t);
      } else if (band(dMid, 140)) {
        c = mix(ACCENT, BG, 0.25);
      } else if (band(dBot, 184)) {
        c = mix(ACCENT2, BG, 0.25);
      }

      px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2];
      px[i + 3] = Math.round(alpha * 255);
    }
  }
  return px;
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function toPng(px) {
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) {
    raw[y * (S * 4 + 1)] = 0; // filter: none
    px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function toIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry[0] = 0; entry[1] = 0;          // 0 == 256px
  entry[2] = 0; entry[3] = 0;
  entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, png]);
}

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const png = toPng(buildPixels());
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
fs.writeFileSync(path.join(outDir, 'icon.ico'), toIco(png));
console.log('icon written:', path.join(outDir, 'icon.ico'), png.length + 'B png');
