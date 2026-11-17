// Call telemetry (server/callTelemetry.mjs, src/callTelemetry.js): the app reports each call connection's numbers;
// admins see them with a summary (push-to-ring within 3 s, voice-output restarts, relay share); bad input is refused.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { cleanCallTelemetry, summarizeCallTelemetry } from './callTelemetry.mjs';
import { callTelemetry, pairTelemetry } from '../src/callTelemetry.js';

const PASSWORD = 'correct horse battery staple';
const ADMIN = { username: 'telemetry_admin', password: 'a-long-admin-password-42' };
let directory;
let service;
let base;
let cookie = '';

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-telemetry-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), pushSender: null, adminCredentials: ADMIN });
  base = `http://127.0.0.1:${(await service.listen()).port}`;
  const login = await fetch(`${base}/api/admin/v1/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HM-Admin': '1' }, body: JSON.stringify(ADMIN) });
  cookie = login.headers.get('set-cookie').split(';')[0];
});
after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function api(path, { token, admin = false, method = 'GET', body } = {}) {
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(admin ? { Cookie: cookie, 'X-HM-Admin': '1' } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  const response = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test('the app turns an engine summary into a bounded report', () => {
  const pair = pairTelemetry('peer-1', { status: 'connected', rtt: 0.052, lost: 5, packets: 995, jitter: 0.012, fps: 20.4, width: 640, height: 360, audioPackets: 1738, audioPlayed: 2.23, path: 'relay', iceRestarts: 1, playoutRestarts: 1, red: true, ringMs: 1450, connectedMs: 61_000 });
  assert.deepEqual(pair, { peerId: 'peer-1', status: 'connected', rttMs: 52, loss: 0.005, jitterMs: 12, fps: 20, width: 640, height: 360, audioPackets: 1738, audioPlayedS: 2.2, path: 'relay', iceRestarts: 1, playoutRestarts: 1, red: true, ringMs: 1450, connectedMs: 61_000 });
  assert.equal(pairTelemetry('p', { rtt: 9999 }).rttMs, 60_000, 'bounded');
  assert.equal(pairTelemetry('p', { path: 'mars' }).path, null);
  const report = callTelemetry({ call: { id: 'c1', roomId: 'r1', mode: 'video', direction: 'outgoing', groupId: 'g' }, pairs: [{ peerId: 'peer-1', telemetry: {} }], final: true });
  assert.deepEqual([report.callId, report.roomId, report.mode, report.direction, report.group, report.final, report.pairs.length], ['c1', 'r1', 'video', 'outgoing', true, true, 1]);
});

test('reports are stored, refused when malformed, and summarized for admins', async () => {
  const alice = (await api('/api/v1/auth/register', { method: 'POST', body: { username: 'tele_alice', dob: '1990-04-12', password: PASSWORD } })).body;
  const report = (callId, pair, final = true) => ({ callId, roomId: callId, mode: 'audio', direction: 'outgoing', final, pairs: [pair] });
  assert.equal((await api('/api/v1/calls/telemetry', { method: 'POST', body: report('c1', { ringMs: 900 }) })).status, 401, 'signed in only');
  assert.equal((await api('/api/v1/calls/telemetry', { token: alice.token, method: 'POST', body: { callId: 'x', pairs: [] } })).status, 400);
  assert.equal((await api('/api/v1/calls/telemetry', { token: alice.token, method: 'POST', body: report('c1', { ringMs: 900, path: 'direct', playoutRestarts: 0 }) })).status, 204);
  assert.equal((await api('/api/v1/calls/telemetry', { token: alice.token, method: 'POST', body: report('c2', { ringMs: 5200, path: 'relay', playoutRestarts: 2, audioPackets: 1738, audioPlayedS: 2.2 }) })).status, 204);
  assert.equal((await api('/api/v1/calls/telemetry', { token: alice.token, method: 'POST', body: report('c2', { ringMs: 5200 }, false) })).status, 204);

  assert.ok([401, 403].includes((await api('/api/admin/v1/call-telemetry')).status), 'admins only');
  const { body } = await api('/api/admin/v1/call-telemetry', { admin: true });
  assert.equal(body.reports.length, 3);
  assert.deepEqual(body.summary, { calls: 2, connections: 2, ringWithinTarget: 0.5, connectionsWithPlayoutRestart: 1, relayShare: 0.5 });
  const one = await api('/api/admin/v1/call-telemetry?callId=c2', { admin: true });
  assert.equal(one.body.reports.length, 2);
  assert.equal(one.body.reports.find((r) => r.final).pairs[0].audioPlayedS, 2.2);
});

test('cleaning drops unknown fields and bounds numbers', () => {
  const clean = cleanCallTelemetry({ callId: 'c', pairs: [{ peerId: 'p', rttMs: -5, loss: 3, secret: 'x', fps: 'abc' }], extra: 1 });
  assert.equal(clean.pairs[0].rttMs, null);
  assert.equal(clean.pairs[0].loss, 1);
  assert.equal(clean.pairs[0].fps, null);
  assert.ok(!('secret' in clean.pairs[0]) && !('extra' in clean));
  assert.equal(cleanCallTelemetry({ callId: 'c'.repeat(81), pairs: [{}] }), null);
  assert.deepEqual(summarizeCallTelemetry([]), { calls: 0, connections: 0, ringWithinTarget: null, connectionsWithPlayoutRestart: 0, relayShare: null });
});

test('the call screen reports every 30 s and once at the end', () => {
  const overlay = readFileSync(new URL('../src/components/CallOverlay.jsx', import.meta.url), 'utf8');
  assert.match(overlay, /setInterval\(\(\) => reportTelemetry\(false\), CALL_TELEMETRY_INTERVAL_MS\)/);
  assert.match(overlay, /if \(!terminal \|\| telemetryFinal\.current\) return;\s+telemetryFinal\.current = true;\s+reportTelemetry\(true\);/);
  const engine = readFileSync(new URL('../src/callEngine.js', import.meta.url), 'utf8');
  assert.match(engine, /if \(offerSentAt && !ringMs\) ringMs = Date\.now\(\) - offerSentAt;/, 'push-to-ring: first offer to "ringing"');
});
