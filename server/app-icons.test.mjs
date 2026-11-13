// App icons (scripts/generate-app-icons.mjs): every file the website, the PWA and the Android launcher and splash
// screens use exists at its declared size, round icons are round, and the adaptive foreground stays inside the
// launcher's safe circle (nothing for a mask to clip).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { OUTPUTS, decodePng, iconSvg } from '../scripts/generate-app-icons.mjs';

const root = new URL('../', import.meta.url);
const alpha = (image, x, y) => image.pixels[(y * image.width + x) * 4 + 3];

test('every generated icon exists at its declared size', async () => {
  for (const output of OUTPUTS) {
    const image = decodePng(await readFile(new URL(output.file, root)));
    assert.deepEqual([image.width, image.height], [output.width, output.height], output.file);
  }
});

test('the manifest names only real icons whose sizes match', async () => {
  const manifest = JSON.parse(await readFile(new URL('public/manifest.webmanifest', root), 'utf8'));
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable' && icon.sizes === '512x512'));
  assert.ok(manifest.icons.some((icon) => icon.purpose === 'any' && icon.sizes === '192x192'));
  for (const icon of manifest.icons) {
    const image = decodePng(await readFile(new URL(`public${icon.src.split('?')[0]}`, root)));
    assert.equal(`${image.width}x${image.height}`, icon.sizes, icon.src);
  }
});

test('round icons are transparent at the corners and solid in the middle; full-bleed ones are solid everywhere', async () => {
  for (const output of OUTPUTS) {
    const image = decodePng(await readFile(new URL(output.file, root)));
    const middle = alpha(image, image.width >> 1, image.height >> 1);
    const corner = alpha(image, 0, 0);
    if (output.variant === 'regular' && output.shape === 'circle') assert.deepEqual([corner, middle], [0, 255], output.file);
    if (output.variant === 'maskable' || output.variant === 'splash') assert.deepEqual([corner, middle], [255, 255], output.file);
    if (output.variant === 'adaptive') assert.equal(corner, 0, output.file);
  }
});

test('the adaptive foreground keeps the whole mark inside the 66-unit safe circle', async () => {
  const output = OUTPUTS.find((item) => item.variant === 'adaptive' && item.width === 432);
  const image = decodePng(await readFile(new URL(output.file, root)));
  const centre = image.width / 2;
  const safe = (33 / 108) * image.width;
  for (let y = 0; y < image.height; y += 2) {
    for (let x = 0; x < image.width; x += 2) {
      if (alpha(image, x, y) > 32) assert.ok(Math.hypot(x - centre, y - centre) <= safe, `opaque pixel at ${x},${y} is outside the safe circle`);
    }
  }
  assert.match(iconSvg('adaptive', 108), /scale\(\.82\)/);
});
