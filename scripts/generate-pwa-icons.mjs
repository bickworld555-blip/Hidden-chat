// Renders the Hidden Messenger PWA icons (green tile, white chat bubble, keyhole) as PNG files without
// image dependencies. Run `node scripts/generate-pwa-icons.mjs` after changing the design; outputs are committed.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const GREEN = [0, 168, 132];
const DARK = [7, 94, 84];
const WHITE = [255, 255, 255];

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes in unit coordinates (0..1). `padding` shrinks the artwork into the maskable safe zone.
function colorAt(x, y, { rounded, padding }) {
  const inTile = rounded ? roundedRect(x, y, 0, 0, 1, 1, 0.22) : true;
  if (!inTile) return null;
  const s = 1 - padding * 2;
  const u = (x - padding) / s;
  const v = (y - padding) / s;
  const bubble = Math.hypot(u - 0.5, v - 0.47) <= 0.3
    || inTriangle(u, v, [0.27, 0.62], [0.42, 0.74], [0.2, 0.85]);
  if (!bubble) return GREEN;
  const keyhole = Math.hypot(u - 0.5, v - 0.42) <= 0.075 || inTriangle(u, v, [0.5, 0.42], [0.44, 0.6], [0.56, 0.6]);
  return keyhole ? DARK : WHITE;
}

function roundedRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return Math.hypot(x - cx, y - cy) <= r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
}

function inTriangle(px, py, a, b, c) {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

export function renderIcon(size, options) {
  const samples = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0; let g = 0; let b = 0; let a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const color = colorAt((x + (sx + 0.5) / samples) / size, (y + (sy + 0.5) / samples) / size, options);
          if (!color) continue;
          r += color[0]; g += color[1]; b += color[2]; a += 1;
        }
      }
      const offset = (y * size + x) * 4;
      if (a) { rgba[offset] = r / a; rgba[offset + 1] = g / a; rgba[offset + 2] = b / a; }
      rgba[offset + 3] = Math.round((a / (samples * samples)) * 255);
    }
  }
  return encodePng(size, rgba);
}

export const ICONS = [
  { file: 'icon-192.png', size: 192, rounded: true, padding: 0.06 },
  { file: 'icon-512.png', size: 512, rounded: true, padding: 0.06 },
  { file: 'maskable-192.png', size: 192, rounded: false, padding: 0.14 },
  { file: 'maskable-512.png', size: 512, rounded: false, padding: 0.14 },
  { file: 'apple-touch-icon.png', size: 180, rounded: false, padding: 0.1 },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const directory = new URL('../public/icons/', import.meta.url);
  await mkdir(directory, { recursive: true });
  for (const icon of ICONS) await writeFile(new URL(icon.file, directory), renderIcon(icon.size, icon));
  console.log(`Wrote ${ICONS.length} icons to public/icons/.`);
}
