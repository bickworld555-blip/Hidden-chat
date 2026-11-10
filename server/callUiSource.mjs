// The call screen's source: CallOverlay.jsx (the call itself) plus its parts in src/components/call/, for tests that
// check what the call screen does wherever the code lives.
import { readdir, readFile } from 'node:fs/promises';

const root = new URL('../src/components/', import.meta.url);

export async function callUiSource() {
  const parts = (await readdir(new URL('call/', root))).filter((name) => /\.(jsx?|mjs)$/.test(name)).sort();
  const files = ['CallOverlay.jsx', ...parts.map((name) => `call/${name}`)];
  return (await Promise.all(files.map((file) => readFile(new URL(file, root), 'utf8')))).join('\n');
}
