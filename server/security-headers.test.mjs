// The website and web app are served with a Content-Security-Policy, no framing, no sniffing and a short referrer
// (server/securityHeaders.mjs); the API only with nosniff. Before 2026-11-22 the pages had HSTS only.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { WEB_CSP, cspForHost } from './securityHeaders.mjs';
import { bundledCsp } from '../scripts/configure-android.mjs';

let directory;
let service;
let baseUrl;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-headers-'));
  writeFileSync(join(directory, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(directory, 'admin.html'), '<!doctype html><div id="admin"></div>');
  writeFileSync(join(directory, 'app.js'), 'export {};');
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null, webDirectory: directory });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('pages and their files carry the policy, forbid framing and sniffing, and send a short referrer', async () => {
  for (const path of ['/', '/app', '/features', '/app.js']) {
    const response = await fetch(baseUrl + path);
    assert.equal(response.status, 200, path);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/, path);
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'(;|$)/, `${path}: no inline or remote scripts`);
    assert.match(csp, /frame-ancestors 'none'/, path);
    assert.match(csp, /object-src 'none'/, path);
    assert.match(csp, /connect-src 'self' blob: data: wss:\/\/127\.0\.0\.1:\d+ /, `${path}: its own socket is named`);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin', path);
  }
});

test('the admin page keeps its stricter headers on top of the policy', async () => {
  const response = await fetch(baseUrl + '/admin');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
});

test('the API answers with nosniff and no page policy', async () => {
  const response = await fetch(baseUrl + '/api/v1/ready', { headers: { 'X-HM-Client': '3' } });
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('content-security-policy'), null);
});

test('one policy for the website and the APK, differing only in how the server is named', () => {
  const bundled = bundledCsp('https://hiddenmessenger.com');
  assert.match(bundled, /connect-src 'self' blob: data: https:\/\/hiddenmessenger\.com wss:\/\/hiddenmessenger\.com /);
  assert.ok(!bundled.includes('frame-ancestors'), 'the APK page is not served over HTTP: unchanged');
  const strip = (policy) => policy.replace(/ (https|wss):\/\/hiddenmessenger\.com/g, '').replace(/; frame-ancestors 'none'; manifest-src 'self'$/, '');
  assert.equal(strip(cspForHost('hiddenmessenger.com')), strip(bundled));
  assert.equal(cspForHost('bad host"; script-src *'), WEB_CSP, 'a malformed Host header never reaches the policy');
  assert.ok(!WEB_CSP.includes('unsafe-eval\'') || WEB_CSP.includes('wasm-unsafe-eval'));
});
