// Server-tunable push and background timings (PUSH_TUNING), per-type FCM priority, and push ids (`pid`) that let a
// retried or second-path push reach a phone once, like WhatsApp's push_id dedup and its server-sent push config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChatServer } from './index.mjs';
import { createRecentPushes, pushBody, pushId } from './push.mjs';
import { clientTuning, fcmPriority, loadPushTuning, pushCfg } from './pushConfig.mjs';

test('PUSH_TUNING: defaults, valid overrides, clamped values, and bad input never stops pushes', () => {
  const defaults = loadPushTuning({});
  assert.deepEqual(pushCfg(defaults), { f: 8000, h: 12000, x: 25000, b: 20000, w: 15000 });
  assert.deepEqual(clientTuning(defaults), { relayWakeQuietMs: 2000, relayWakeMaxMs: 15000 });
  assert.equal(defaults.deliveryPushMs, 8000);
  assert.equal(defaults.hiddenSettleMs, 2000);

  const tuned = loadPushTuning({ PUSH_TUNING: JSON.stringify({ fallbackNoticeMs: 10_000, relayWakeMaxMs: 999_999, backgroundFetchMs: 1, unknown: 5, priority: { react: 'normal', call: 'low', nope: 'normal' } }) });
  assert.equal(tuned.fallbackNoticeMs, 10_000, 'a valid value is taken');
  assert.equal(tuned.relayWakeMaxMs, 120_000, 'too large: clamped to the maximum');
  assert.equal(tuned.backgroundFetchMs, 5_000, 'too small: clamped to the minimum (the short service still runs)');
  assert.ok(!('unknown' in tuned));
  assert.equal(fcmPriority(tuned, { t: 'react' }), 'NORMAL');
  assert.equal(fcmPriority(tuned, { t: 'call' }), 'HIGH', 'an unknown priority keeps the default');
  assert.equal(fcmPriority(defaults, { t: 'msg' }), 'HIGH');

  const raised = loadPushTuning({ PUSH_TUNING: JSON.stringify({ fallbackNoticeMs: 40_000, fallbackMaxMs: 6_000 }) });
  assert.equal(raised.fallbackMaxMs, 40_000, 'the sealed notice never waits less than its first check');

  for (const broken of ['not json', '[1,2]', '"x"']) assert.deepEqual(loadPushTuning({ PUSH_TUNING: broken }), defaults, `ignored: ${broken}`);
});

test('push ids: one event, one id over every path; random where the event has no id of its own', () => {
  assert.equal(pushBody.message({ id: 'm1', from: 'u' }).pid, 'm:m1');
  assert.equal(pushBody.wake({ from: 'u', messageId: 'm1' }).pid, 'w:m1', 'the Firebase and socket wake-ups for one message agree');
  assert.equal(pushBody.call({ callId: 'c1', from: 'u' }).pid, 'c:c1');
  assert.equal(pushBody.callEnd({ callId: 'c1' }).pid, 'e:c1', 'the end of a call is not a repeat of its ring');
  assert.notEqual(pushBody.wake({ from: 'u' }).pid, pushBody.wake({ from: 'u' }).pid);
  assert.notEqual(pushBody.reaction({ id: 'm1', from: 'u' }).pid, pushBody.reaction({ id: 'm1', from: 'u' }).pid);
  assert.ok(pushId('m', 'x'.repeat(500)).length <= 82, 'a long id cannot outgrow the push');
});

test('the server sends a push id to a phone once per window, and lets a failed one be retried', () => {
  let clock = 1_000;
  const recent = createRecentPushes(60_000, () => clock);
  assert.equal(recent.seen('tok', 'w:m1'), false, 'first: sent');
  assert.equal(recent.seen('tok', 'w:m1'), true, 'again: dropped');
  assert.equal(recent.seen('other', 'w:m1'), false, 'another phone still gets it');
  assert.equal(recent.seen('tok', undefined), false, 'no id: never held back');
  recent.forget('tok', 'w:m1');
  assert.equal(recent.seen('tok', 'w:m1'), false, 'failed and forgotten: retried');
  clock += 60_001;
  assert.equal(recent.seen('tok', 'w:m2'), false);
  assert.equal(recent.size, 1, 'expired entries are dropped');
  assert.equal(recent.seen('tok', 'w:m1'), false, 'after the window it may go again');
});

test('GET /api/v1/push/config gives the signed-in app its timings from PUSH_TUNING', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'relay-push-tuning-'));
  const service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'),
    pushTuning: loadPushTuning({ PUSH_TUNING: JSON.stringify({ relayWakeQuietMs: 3_000 }) }) });
  try {
    const baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
    assert.equal((await fetch(`${baseUrl}/api/v1/push/config`)).status, 401, 'signed-in apps only');
    const registered = await (await fetch(`${baseUrl}/api/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tuning1', dob: '1990-04-12', password: 'Correct-Horse-Battery-42!' }) })).json();
    const response = await fetch(`${baseUrl}/api/v1/push/config`, { headers: { Authorization: `Bearer ${registered.token}` } });
    assert.deepEqual(await response.json(), { relayWakeQuietMs: 3_000, relayWakeMaxMs: 15_000 });
  } finally {
    await service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
