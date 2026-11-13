// Generates every app icon (website, PWA, Android launcher and splash screens) from one drawing: a white speech
// bubble on blue with an "H" whose two stems are two people facing each other, joined by the crossbar between them
// (a conversation). The drawing is SVG below; a local headless Chrome or Edge renders each size exactly, so the
// script runs on a developer machine (the PNGs are committed): node scripts/generate-app-icons.mjs
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

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


// --- The drawing (108 × 108 units, Android's adaptive icon grid; the mark stays inside its 66-unit safe circle) ---
export const BRAND_BLUE = '#0b57d0';
const BLUE_LIGHT = '#2f7df0';
const BLUE_DEEP = '#0a3f9e';

// The mark: bubble (circle + tail at the lower left) and the H inside it: two people (head and shoulders, heads
// turned toward each other) whose bodies are the stems, joined by the crossbar between them.
function mark(ink = BRAND_BLUE) {
  return `
    <path fill="#fff" d="M54 23a30 30 0 1 1-15.9 55.5L26 82.5l4.2-11.6A30 30 0 0 1 54 23z"/>
    <g fill="${ink}">
      <circle cx="44.8" cy="38.4" r="5"/>
      <circle cx="63.2" cy="38.4" r="5"/>
      <path d="M37.4 50.4a5.6 5.6 0 0 1 11.2 0l-.9 17.2a4.7 4.7 0 0 1-9.4 0z"/>
      <path d="M59.4 50.4a5.6 5.6 0 0 1 11.2 0l-.9 17.2a4.7 4.7 0 0 1-9.4 0z"/>
      <rect x="47.4" y="54.4" width="13.2" height="5.4" rx="2.7"/>
    </g>`;
}
const gradient = `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${BLUE_LIGHT}"/><stop offset="1" stop-color="${BLUE_DEEP}"/></linearGradient></defs>`;

/**
 * The icon as SVG. variant: 'regular' (blue disc or rounded square with the mark), 'maskable' (full-bleed blue square,
 * mark in the safe zone), 'adaptive' (the mark alone on transparent: Android's adaptive foreground), 'splash'
 * (full-bleed blue, the mark centred at a third of the short side).
 */
export function iconSvg(variant, width, height = width, shape = 'circle') {
  // Scaled into Android's 66-unit safe circle so no launcher mask clips the bubble's tail.
  if (variant === 'adaptive') return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 108 108"><g transform="translate(54 54) scale(.82) translate(-54 -54)">${mark()}</g></svg>`;
  if (variant === 'maskable') return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 108 108">${gradient}<rect width="108" height="108" fill="url(#bg)"/>${mark()}</svg>`;
  if (variant === 'splash') {
    const side = Math.min(width, height) / 3;
    const scale = side / 66;
    const x = width / 2 - 54 * scale;
    const y = height / 2 - 54 * scale;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${gradient}<rect width="${width}" height="${height}" fill="url(#bg)"/><g transform="translate(${x} ${y}) scale(${scale})">${mark()}</g></svg>`;
  }
  // Regular: the mark fills the disc a little more than the adaptive grid (no launcher mask crops it).
  const back = shape === 'circle' ? '<circle cx="54" cy="54" r="54" fill="url(#bg)"/>' : shape === 'rounded' ? '<rect width="108" height="108" rx="24" fill="url(#bg)"/>' : '<rect width="108" height="108" fill="url(#bg)"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 108 108">${gradient}${back}<g transform="translate(54 54) scale(1.12) translate(-54 -54)">${mark()}</g></svg>`;
}

const SPLASH = [['land-hdpi', 800, 480], ['land-mdpi', 480, 320], ['land-xhdpi', 1280, 720], ['land-xxhdpi', 1600, 960], ['land-xxxhdpi', 1920, 1280],
  ['port-hdpi', 480, 800], ['port-mdpi', 320, 480], ['port-xhdpi', 720, 1280], ['port-xxhdpi', 960, 1600], ['port-xxxhdpi', 1280, 1920]];
export const OUTPUTS = [
  { file: 'public/icons/icon-192.png', variant: 'regular', width: 192, height: 192, shape: 'circle' },
  { file: 'public/icons/icon-512.png', variant: 'regular', width: 512, height: 512, shape: 'circle' },
  { file: 'public/icons/maskable-192.png', variant: 'maskable', width: 192, height: 192 },
  { file: 'public/icons/maskable-512.png', variant: 'maskable', width: 512, height: 512 },
  { file: 'public/icons/apple-touch-icon.png', variant: 'regular', width: 180, height: 180, shape: 'square' },
  ...[['mdpi', 48, 108], ['hdpi', 72, 162], ['xhdpi', 96, 216], ['xxhdpi', 144, 324], ['xxxhdpi', 192, 432]].flatMap(([density, launcher, foreground]) => [
    { file: `android/app/src/main/res/mipmap-${density}/ic_launcher.png`, variant: 'regular', width: launcher, height: launcher, shape: 'circle' },
    { file: `android/app/src/main/res/mipmap-${density}/ic_launcher_round.png`, variant: 'regular', width: launcher, height: launcher, shape: 'circle' },
    { file: `android/app/src/main/res/mipmap-${density}/ic_launcher_foreground.png`, variant: 'adaptive', width: foreground, height: foreground },
  ]),
  { file: 'android/app/src/main/res/drawable/splash.png', variant: 'splash', width: 480, height: 320 },
  ...SPLASH.map(([folder, width, height]) => ({ file: `android/app/src/main/res/drawable-${folder}/splash.png`, variant: 'splash', width, height })),
];

// --- Rendering through the DevTools protocol of a local Chrome or Edge ---
const BROWSERS = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

async function render(root) {
  const executable = process.env.CHROME_PATH || BROWSERS.find((path) => existsSync(path));
  if (!executable) throw new Error('No Chrome or Edge found; set CHROME_PATH.');
  const { default: WebSocket } = await import('ws');
  const port = 9300 + Math.floor(Math.random() * 500);
  const browser = spawn(executable, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${await mkdtemp(join(tmpdir(), 'icons-'))}`, '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  try {
    let page;
    for (let attempt = 0; attempt < 50 && !page; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      page = await fetch(`http://127.0.0.1:${port}/json`).then((response) => response.json()).then((list) => list.find((target) => target.type === 'page')).catch(() => null);
    }
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve) => socket.once('open', resolve));
    let next = 0;
    const waiting = new Map();
    socket.on('message', (raw) => { const message = JSON.parse(raw); waiting.get(message.id)?.(message); waiting.delete(message.id); });
    const call = (method, params = {}) => new Promise((resolve) => { next += 1; waiting.set(next, resolve); socket.send(JSON.stringify({ id: next, method, params })); });
    await call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (const output of OUTPUTS) {
      await call('Emulation.setDeviceMetricsOverride', { width: output.width, height: output.height, deviceScaleFactor: 1, mobile: false });
      const html = `<!doctype html><html><style>html,body{margin:0;overflow:hidden;background:transparent}svg{display:block}</style><body>${iconSvg(output.variant, output.width, output.height, output.shape)}</body></html>`;
      await call('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
      await new Promise((resolve) => setTimeout(resolve, 120));
      const shot = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: output.width, height: output.height, scale: 1 } });
      const target = new URL(output.file, root);
      await mkdir(new URL('./', target), { recursive: true });
      await writeFile(target, Buffer.from(shot.result.data, 'base64'));
    }
    socket.close();
  } finally {
    browser.kill();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL('../', import.meta.url);
  await writeFile(new URL('assets/brand/app-icon.svg', root), `${iconSvg('regular', 512, 512, 'circle')}\n`);
  await render(root);
  console.log(`Wrote ${OUTPUTS.length} icons and assets/brand/app-icon.svg.`);
}
