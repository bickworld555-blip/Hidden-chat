// Upload allowances (server/abuse.mjs createTokenBuckets): a burst, then a steady refill; shared through the database
// so several processes never spend the same tokens; enforced on every upload path with 429 + Retry-After.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { abuseLimitsFromEnv, createTokenBuckets, ensureRateLimitSchema } from './abuse.mjs';
import { createChatServer } from './index.mjs';

function buckets(clock) {
  const db = new DatabaseSync(':memory:');
  ensureRateLimitSchema(db);
  return { db, buckets: createTokenBuckets({ db, secret: 'test', now: () => clock.t }) };
}

test('a token bucket allows the burst, then refills at the steady rate, and says how long to wait', async () => {
  const clock = { t: 1_000_000 };
  const { buckets: b } = buckets(clock);
  const rule = { capacity: 10, perSecond: 2 };
  assert.equal(await b.take('k', rule, 10), 0, 'the whole burst');
  assert.equal(await b.take('k', rule, 1), 500, 'empty: one token comes back in 0.5 s');
  clock.t += 1500;
  assert.equal(await b.take('k', rule, 3), 0, '1.5 s later: 3 tokens');
  assert.equal(await b.take('k', rule, 1), 500);
  clock.t += 60_000;
  assert.equal(await b.take('k', rule, 10), 0, 'refilled, but never above the capacity');
  assert.equal(await b.take('k', rule, 1), 500);
  assert.equal(await b.take('other', rule, 11), Infinity, 'more than the capacity can never pass');
  assert.equal(await b.take('other', rule, 10), 0, 'keys are separate');
});

test('two processes sharing the database never spend the same tokens', async () => {
  const clock = { t: 5_000_000 };
  const { db } = buckets(clock);
  const first = createTokenBuckets({ db, secret: 'test', now: () => clock.t });
  const second = createTokenBuckets({ db, secret: 'test', now: () => clock.t });
  const rule = { capacity: 20, perSecond: 1 };
  const results = await Promise.all(Array.from({ length: 30 }, (_, index) => (index % 2 ? first : second).take('shared', rule, 1)));
  assert.equal(results.filter((wait) => wait === 0).length, 20, 'exactly the capacity was allowed');
  const stored = db.prepare('SELECT key FROM token_buckets').all();
  assert.ok(stored.every((row) => /^[0-9a-f]{40}$/.test(row.key)), 'keys are HMACs, not account ids');
});

test('upload limits are read from the environment, on only with abuse limits', () => {
  assert.equal(abuseLimitsFromEnv({}), null);
  const limits = abuseLimitsFromEnv({ RELAY_ABUSE_LIMITS: '1', RELAY_UPLOAD_PARTS_BURST: '50', RELAY_UPLOAD_MB_PER_SECOND: '10', RELAY_UPLOAD_GB_PER_DAY: '20' });
  assert.deepEqual(limits.uploadParts, { capacity: 50, perSecond: 2 });
  assert.deepEqual(limits.uploadBytes, { capacity: 2048 * 1024 ** 2, perSecond: 10 * 1024 ** 2 });
  assert.equal(limits.uploadBytesDaily.capacity, 20 * 1024 ** 3);
});

let service;
let directory;
let baseUrl;
before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-upload-limits-'));
  const abuseLimits = abuseLimitsFromEnv({ RELAY_ABUSE_LIMITS: '1', RELAY_TRUST_PROXY_HOPS: '0', RELAY_UPLOAD_MB_BURST: '8', RELAY_UPLOAD_MB_PER_SECOND: '1' });
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory, pushSender: null, abuseLimits });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
});
after(async () => {
  await service?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('uploads past the allowance are refused with 429 and Retry-After, on the single and chunked paths', async () => {
  const headers = { 'X-HM-Client': '2', 'Content-Type': 'application/json' };
  const user = await (await fetch(`${baseUrl}/api/v1/auth/register`, { method: 'POST', headers, body: JSON.stringify({ username: 'uploadlimit', dob: '1990-01-01', password: 'Correct-Horse-Battery-42!' }) })).json();
  const auth = { 'X-HM-Client': '2', Authorization: `Bearer ${user.token}` };
  const send = (bytes) => fetch(`${baseUrl}/api/v1/media?receiverId=${user.user.id}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'a.bin' }, body: new Uint8Array(bytes) });
  assert.equal((await send(5 * 1024 ** 2)).status, 201, 'within the 8 MB burst');
  const refused = await send(5 * 1024 ** 2);
  assert.equal(refused.status, 429, 'the burst is spent');
  assert.ok(Number(refused.headers.get('retry-after')) >= 1);
  assert.equal((await refused.json()).code, 'rate_limited');
  // The chunked path is charged per chunk, before the bytes are written.
  const created = await (await fetch(`${baseUrl}/api/v1/uploads`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ receiverId: user.user.id, filename: 'b.bin', byteSize: 4 * 1024 ** 2 }) })).json();
  const chunk = await fetch(`${baseUrl}/api/v1/uploads/${created.uploadId}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': '0' }, body: new Uint8Array(4 * 1024 ** 2) });
  assert.equal(chunk.status, 429);
});

test('without R2 settings the server keeps attachments on disk: no direct uploads offered, a direct request falls back', async () => {
  assert.equal(process.env.MEDIA_STORAGE, undefined, 'the test environment has no object storage');
  const headers = { 'X-HM-Client': '2', 'Content-Type': 'application/json' };
  const user = await (await fetch(`${baseUrl}/api/v1/auth/register`, { method: 'POST', headers, body: JSON.stringify({ username: 'diskonly', dob: '1990-01-01', password: 'Correct-Horse-Battery-42!' }) })).json();
  const auth = { 'X-HM-Client': '2', Authorization: `Bearer ${user.token}` };
  assert.deepEqual(await (await fetch(`${baseUrl}/api/v1/uploads/config`, { headers: auth })).json(), { direct: false });
  const created = await (await fetch(`${baseUrl}/api/v1/uploads`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ receiverId: user.user.id, filename: 'c.bin', byteSize: 3, direct: true }) })).json();
  assert.equal(created.direct, undefined, 'no bucket: the disk path');
  assert.ok(created.chunkBytes > 0);
  assert.equal((await fetch(`${baseUrl}/api/v1/uploads/${created.uploadId}`, { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/octet-stream', 'X-Upload-Offset': '0' }, body: new Uint8Array([1, 2, 3]) })).status, 200);
  const done = await (await fetch(`${baseUrl}/api/v1/uploads/${created.uploadId}/complete`, { method: 'POST', headers: auth })).json();
  const download = await fetch(`${baseUrl}/api/v1/media/${done.id}?locate=1`, { headers: auth });
  assert.equal(download.headers.get('x-hm-media-location'), null, 'served from disk, not located in a bucket');
  assert.deepEqual([...new Uint8Array(await download.arrayBuffer())], [1, 2, 3]);
});
