// Generates every app icon (PWA, maskable, Apple touch, Android launcher) from the brand artwork in
// assets/brand/logo-source.png. Crops the shield emblem (not the wordmark below it), resamples with an
// area-average filter and writes PNGs. No image dependencies. Run: node scripts/generate-app-icons.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

// Emblem geometry in the source artwork (939x1024): the shield spans roughly x 185-750, y 95-795;
// the wordmark starts near y 860 and must stay out of every crop's visible area.
const EMBLEM = { x: 467, y: 445 };
// Rows below this are wordmark territory; extended canvas beyond it (and beyond the image) mirrors the
// woven texture and fades to deep green, so no crop ever shows letters or smeared edge pixels.
const ARTWORK_BOTTOM = 820;
const DEEP_GREEN = [8, 46, 30];
const FADE_PX = 55;
const CROPS = {
  // Full-bleed "any" icon: the emblem fills most of the tile, like the brand artwork.
  regular: { cx: EMBLEM.x, cy: EMBLEM.y, side: 760 },
  // Maskable: the whole shield must sit inside the spec's safe circle (radius 40% of the icon).
  maskable: { cx: EMBLEM.x, cy: 436, side: 960 },
  // Android adaptive foreground (108dp, 72dp visible, 66dp safe): the emblem fits the safe zone.
  adaptive: { cx: EMBLEM.x, cy: 445, side: 1219 },
};

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// Decodes 8-bit, non-interlaced RGB/RGBA PNGs into RGBA.
export function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('Not a PNG file.');
  let offset = 8;
  let width; let height; let colorType;
  const data = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      colorType = body[9];
      if (body[8] !== 8 || ![2, 6].includes(colorType) || body[12] !== 0) throw new Error('Only 8-bit non-interlaced RGB/RGBA PNGs are supported.');
    } else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(data));
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const upLeft = i >= channels ? previous[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else if (filter !== 0) throw new Error(`Unknown PNG filter ${filter}.`);
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const target = (y * width + x) * 4;
      pixels[target] = line[x * channels];
      pixels[target + 1] = line[x * channels + 1];
      pixels[target + 2] = line[x * channels + 2];
      pixels[target + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    previous = line;
  }
  return { width, height, pixels };
}

export function encodePng(size, rgba) {
  const chunk = (type, body) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
    const content = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(content));
    return Buffer.concat([length, content, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const reflect = (value, limit) => {
  let v = value;
  for (let i = 0; i < 4 && (v < 0 || v > limit); i += 1) v = v < 0 ? -v : 2 * limit - v;
  return Math.min(limit, Math.max(0, v));
};

// Area-average resample of a square crop over the extended canvas described at ARTWORK_BOTTOM.
export function renderCrop(image, { cx, cy, side }, size, mask = 'none') {
  const out = Buffer.alloc(size * size * 4);
  const scale = side / size;
  const left = cx - side / 2;
  const top = cy - side / 2;
  const bottom = Math.min(ARTWORK_BOTTOM, image.height - 1);
  const sample = (x, y) => {
    const outside = Math.max(0, -x, x - (image.width - 1), -y, y - bottom);
    const index = (reflect(y, bottom) * image.width + reflect(x, image.width - 1)) * 4;
    const keep = outside ? Math.max(0, 1 - outside / FADE_PX) ** 1.5 : 1;
    return [0, 1, 2].map((channel) => image.pixels[index + channel] * keep + DEEP_GREEN[channel] * (1 - keep));
  };
  for (let y = 0; y < size; y += 1) {
    const y0 = top + y * scale; const y1 = y0 + scale;
    for (let x = 0; x < size; x += 1) {
      const x0 = left + x * scale; const x1 = x0 + scale;
      let r = 0; let g = 0; let b = 0; let total = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
          const weight = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          const [sr, sg, sb] = sample(sx, sy);
          r += sr * weight; g += sg * weight; b += sb * weight;
          total += weight;
        }
      }
      const offset = (y * size + x) * 4;
      out[offset] = Math.round(r / total); out[offset + 1] = Math.round(g / total); out[offset + 2] = Math.round(b / total);
      out[offset + 3] = Math.round(255 * coverage(mask, (x + 0.5) / size, (y + 0.5) / size, 1 / size));
    }
  }
  return encodePng(size, out);
}

// Anti-aliased alpha for circle and rounded-square masks; `pixel` is one pixel in unit coordinates.
function coverage(mask, u, v, pixel) {
  if (mask === 'none') return 1;
  let distance;
  if (mask === 'circle') distance = Math.hypot(u - 0.5, v - 0.5) - 0.5;
  else {
    const radius = 0.18;
    const qx = Math.max(Math.abs(u - 0.5) - (0.5 - radius), 0);
    const qy = Math.max(Math.abs(v - 0.5) - (0.5 - radius), 0);
    distance = Math.hypot(qx, qy) - radius;
  }
  return Math.min(1, Math.max(0, 0.5 - distance / pixel));
}

export const OUTPUTS = [
  { file: 'public/icons/icon-192.png', crop: 'regular', size: 192, mask: 'rounded' },
  { file: 'public/icons/icon-512.png', crop: 'regular', size: 512, mask: 'rounded' },
  { file: 'public/icons/maskable-192.png', crop: 'maskable', size: 192 },
  { file: 'public/icons/maskable-512.png', crop: 'maskable', size: 512 },
  { file: 'public/icons/apple-touch-icon.png', crop: 'regular', size: 180 },
  ...[['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216], ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432]].flatMap(([density, launcher, foreground]) => [
    { file: `android/app/src/main/res/mipmap-${density}/ic_launcher.png`, crop: 'regular', size: launcher, mask: 'rounded' },
    { file: `android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`, crop: 'regular', size: launcher, mask: 'circle' },
    { file: `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`, crop: 'adaptive', size: foreground },
  ]),
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../', import.meta.url);
  const image = decodePng(await readFile(new URL('assets/brand/logo-source.png', root)));
  for (const output of OUTPUTS) {
    const target = new URL(output.file, root);
    await mkdir(new URL('./', target), { recursive: true });
    await writeFile(target, renderCrop(image, CROPS[output.crop], output.size, output.mask));
  }
  console.log(`Wrote ${OUTPUTS.length} icons from assets/brand/logo-source.png.`);
}
