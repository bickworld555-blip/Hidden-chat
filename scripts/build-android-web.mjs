// Builds the web app that is packaged inside the APK (dist-android/): compiled against the API origin in
// ANDROID_APP_URL, with a strict Content-Security-Policy, and checked to be self-contained (every script and
// stylesheet is a local file, nothing points at a website, no service worker).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANDROID_WEB_DIR, apiOrigin } from './configure-android.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

/** Throws unless the built folder is self-contained: index.html loads only local scripts and styles. */
export function verifyBundle(directory) {
  const index = join(directory, 'index.html');
  if (!existsSync(index)) throw new Error(`${directory} has no index.html.`);
  const html = readFileSync(index, 'utf8');
  if (!html.includes('http-equiv="Content-Security-Policy"')) throw new Error('The bundled index.html has no Content-Security-Policy.');
  const sources = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
  const remote = sources.filter((source) => /^(?:https?:)?\/\//i.test(source));
  if (remote.length) throw new Error(`The bundled app references remote code: ${remote.join(', ')}`);
  for (const source of sources) {
    const file = join(directory, source.replace(/^\//, '').split('?')[0]);
    if (!existsSync(file)) throw new Error(`The bundled app references a missing file: ${source}`);
  }
  if (existsSync(join(directory, 'sw.js'))) throw new Error('The bundled app must not ship the website service worker.');
  let bytes = 0;
  const walk = (folder) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else bytes += info.size;
    }
  };
  walk(directory);
  return { scripts: sources.length, bytes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const origin = apiOrigin(process.env.ANDROID_APP_URL);
  const outDir = join(root, ANDROID_WEB_DIR);
  rmSync(outDir, { recursive: true, force: true });
  execFileSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--mode', 'android', '--outDir', ANDROID_WEB_DIR, '--emptyOutDir'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, VITE_API_BASE_URL: origin, ANDROID_APP_URL: origin },
  });
  rmSync(join(outDir, 'sw.js'), { force: true });
  const { scripts, bytes } = verifyBundle(outDir);
  console.log(`Bundled app ready in ${ANDROID_WEB_DIR}/ (${scripts} local scripts/styles, ${(bytes / 1024 / 1024).toFixed(1)} MB), API ${origin}.`);
}
