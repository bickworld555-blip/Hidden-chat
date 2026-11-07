// Copies the MediaPipe vision WASM runtime from node_modules into public/ so the app serves it itself
// (no CDN for the runtime). Runs before `vite` and `vite build`; safe to re-run.
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const target = join(root, 'public', 'mediapipe', 'wasm');

if (!existsSync(source)) {
  console.warn('[mediapipe] @mediapipe/tasks-vision is not installed; the avatar face tracker will be unavailable.');
  process.exit(0);
}
mkdirSync(target, { recursive: true });
let copied = 0;
for (const name of readdirSync(source)) {
  const from = join(source, name);
  const to = join(target, name);
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
  copyFileSync(from, to);
  copied += 1;
}
console.log(`[mediapipe] wasm runtime ready in public/mediapipe/wasm${copied ? ` (${copied} file${copied === 1 ? '' : 's'} copied)` : ''}`);
