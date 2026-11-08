import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createChatServer } from './index.mjs';

const mainUrl = pathToFileURL(join(import.meta.dirname, 'main.mjs')).href;

// Loads main.mjs the way managed hosts do: imported by a wrapper, so process.argv[1] is not the entry file.
function startThroughWrapper(t, env) {
  const directory = mkdtempSync(join(tmpdir(), 'relay-main-'));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(mainUrl)});`], {
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, RELAY_DATA_DIRECTORY: directory, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve({ code, stdout, stderr })));
  // The child must exit before its data directory can be removed (Windows keeps open SQLite files locked).
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    rmSync(directory, { recursive: true, force: true });
  });
  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server did not listen. stderr: ${stderr}`)), 10_000);
    child.stdout.on('data', () => {
      const match = /listening on .+:(\d+)/.exec(stdout);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    exited.then(() => { clearTimeout(timer); reject(new Error(`Server exited. stderr: ${stderr}`)); });
  });
  listening.catch(() => {});
  return { listening, exited };
}

test('main.mjs listens when loaded through a host wrapper', async (t) => {
  const { listening } = startThroughWrapper(t, { PORT: '0', HOST: '127.0.0.1' });
  const port = await listening;
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('main.mjs exits with the startup failure reason instead of hanging', async (t) => {
  const { exited } = startThroughWrapper(t, {
    NODE_ENV: 'production', PORT: '4999', HOST: '127.0.0.1', RELAY_ALLOWED_ORIGINS: 'https://chat.example.com',
  });
  const { code, stderr } = await exited;
  assert.equal(code, 1);
  assert.match(stderr, /Hidden Messenger server failed to start: Production requires DATABASE_URL/);
});

test('serves the built frontend with an SPA fallback without shadowing the API', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-web-'));
  const webDirectory = join(directory, 'dist');
  mkdirSync(join(webDirectory, 'assets'), { recursive: true });
  writeFileSync(join(webDirectory, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(webDirectory, 'assets', 'app.js'), 'console.log(1);');
  const service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'test.sqlite'), dataDirectory: directory, webDirectory });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const { port } = await service.listen();
  const base = `http://127.0.0.1:${port}`;

  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /id="root"/);

  const asset = await fetch(`${base}/assets/app.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);

  const clientRoute = await fetch(`${base}/chats/123`);
  assert.equal(clientRoute.status, 200);
  assert.match(await clientRoute.text(), /id="root"/);

  assert.deepEqual(await (await fetch(`${base}/api/v1/health`)).json(), { status: 'ok' });
  const unknownApi = await fetch(`${base}/api/v1/does-not-exist`);
  assert.equal(unknownApi.status, 404);
  assert.doesNotMatch(await unknownApi.text(), /id="root"/);
});

test('does not serve a frontend when no build is present', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-noweb-'));
  const service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'test.sqlite'), dataDirectory: directory, webDirectory: join(directory, 'missing') });
  t.after(async () => { await service.close(); rmSync(directory, { recursive: true, force: true }); });
  const { port } = await service.listen();
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
});
