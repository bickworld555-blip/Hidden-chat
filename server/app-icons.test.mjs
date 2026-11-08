import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { OUTPUTS, decodePng, encodePng, renderCrop } from '../scripts/generate-app-icons.mjs';

const root = new URL('../', import.meta.url);

test('every generated icon exists at its declared size', async () => {
  for (const output of OUTPUTS) {
    const image = decodePng(await readFile(new URL(output.file, root)));
    assert.equal(image.width, output.size, output.file);
    assert.equal(image.height, output.size, output.file);
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

test('masked icons are transparent outside their shape and the codec round-trips', () => {
  const pixels = Buffer.alloc(4 * 4 * 4, 200);
  const source = decodePng(encodePng(4, pixels));
  assert.deepEqual([source.width, source.height, source.pixels[0], source.pixels[3]], [4, 4, 200, 200]);
  const round = decodePng(renderCrop({ width: 4, height: 4, pixels: Buffer.alloc(64, 255) }, { cx: 2, cy: 2, side: 4 }, 32, 'circle'));
  assert.equal(round.pixels[3], 0, 'corner is transparent');
  assert.equal(round.pixels[(16 * 32 + 16) * 4 + 3], 255, 'centre is opaque');
});
