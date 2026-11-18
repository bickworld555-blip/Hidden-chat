// Regression (production, 2026-11-18): a browser long-polling a "Link a device" QR code that expired took the whole API
// down. The poll's callback ran a second time on the request's late 'close' event, after the handler had replaced its
// item with undefined: "Cannot read properties of undefined (reading 'waiters')", uncaught in an event handler.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { HISTORY_TTL_MS, LINK_TTL_MS, registerLinking } from './linking.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function linkingServer() {
  const clock = { now: 1_000_000 };
  const app = express();
  app.use(express.json());
  const session = { user_id: 'u1', device_id: 'phone-1', token_hash: 'h' };
  const requireSession = (request, _response, next) => { request.session = session; next(); };
  registerLinking({ app, requireSession, issueSession: async () => ({ token: 't', user: { id: 'u1' } }), suspended: async () => false, now: () => clock.now });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { clock, server, base, post };
}

// Records uncaught errors while a check runs: the bug threw from an event handler, outside any request.
async function withoutCrashes(check) {
  const crashes = [];
  const record = (error) => crashes.push(error);
  process.on('uncaughtException', record);
  try {
    await check();
    await sleep(300); // the request's 'close' event comes after the response
  } finally {
    process.off('uncaughtException', record);
  }
  assert.deepEqual(crashes.map((error) => error.message), [], 'no uncaught error after the poll ended');
}

test('a QR code that expires during its long poll answers 404 and the server keeps running', async () => {
  const { clock, server, base, post } = await linkingServer();
  try {
    await withoutCrashes(async () => {
      const { id, secret } = await (await post('/api/v1/link/requests')).json();
      const poll = fetch(`${base}/api/v1/link/requests/${id}?secret=${secret}`);
      await sleep(100);
      clock.now += LINK_TTL_MS + 1;
      await post('/api/v1/link/requests'); // any request sweeps: the expired one wakes its poll
      const response = await poll;
      assert.equal(response.status, 404);
      await response.text();
    });
    const after = await post('/api/v1/link/requests');
    assert.equal(after.status, 201, 'still serving');
  } finally {
    server.close();
  }
});

test('a history long poll whose link expires ends cleanly too', async () => {
  const { clock, server, base, post } = await linkingServer();
  try {
    await withoutCrashes(async () => {
      const { id, secret, code } = await (await post('/api/v1/link/requests', { publicKey: undefined })).json();
      assert.equal((await post(`/api/v1/link/requests/${id}/approve`, { code })).status < 300, true, 'approved by the phone');
      const poll = fetch(`${base}/api/v1/link/requests/${id}/history?secret=${secret}&part=0`);
      await sleep(100);
      clock.now += HISTORY_TTL_MS + 1;
      await post('/api/v1/link/requests');
      const response = await poll;
      assert.equal(response.status, 404);
      await response.text();
    });
  } finally {
    server.close();
  }
});
