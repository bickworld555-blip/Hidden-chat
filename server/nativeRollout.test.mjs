// The native Android E2E rollout gate (server/nativeRollout.mjs): env parsing, the stable per-account bucket, and
// eligibility (allowlist OR within the percent). Mirrors the XMPP rollout tests.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeEnabledFor, nativeRolloutBucket, nativeRolloutFromEnv } from './nativeRollout.mjs';

test('native rollout: env parsing is clamped and tolerant', () => {
  assert.deepEqual(nativeRolloutFromEnv({}), { percent: 0, userIds: new Set() });
  assert.equal(nativeRolloutFromEnv({ NATIVE_E2E_ROLLOUT_PERCENT: '250' }).percent, 100);
  assert.equal(nativeRolloutFromEnv({ NATIVE_E2E_ROLLOUT_PERCENT: '-5' }).percent, 0);
  assert.equal(nativeRolloutFromEnv({ NATIVE_E2E_ROLLOUT_PERCENT: 'lots' }).percent, 0);
  assert.deepEqual([...nativeRolloutFromEnv({ NATIVE_E2E_ROLLOUT_USER_IDS: ' a , b,,' }).userIds], ['a', 'b']);
});

test('native rollout: the bucket is stable per account and spreads 0-99', () => {
  assert.equal(nativeRolloutBucket('user-42'), nativeRolloutBucket('user-42'), 'the same user, the same bucket, every time');
  const buckets = Array.from({ length: 2000 }, (_, i) => nativeRolloutBucket(`u${i}`));
  assert.ok(buckets.every((b) => Number.isInteger(b) && b >= 0 && b < 100));
  assert.ok(new Set(buckets).size > 50, 'buckets are spread, not clustered');
});

test('native rollout: the native cohort is independent of the XMPP one', async () => {
  const { rolloutBucket } = await import('./xmpp.mjs');
  const differ = Array.from({ length: 500 }, (_, i) => `u${i}`).filter((id) => nativeRolloutBucket(id) !== rolloutBucket(id));
  assert.ok(differ.length > 100, 'a different salt puts most accounts in a different bucket than XMPP');
});

test('native rollout: eligibility is default-off, allowlist, then percent', () => {
  assert.equal(nativeEnabledFor('anyone', nativeRolloutFromEnv({})), false, 'default off');
  assert.equal(nativeEnabledFor('', nativeRolloutFromEnv({ NATIVE_E2E_ROLLOUT_PERCENT: '100' })), false, 'no user id, never');
  assert.equal(nativeEnabledFor('staged', nativeRolloutFromEnv({ NATIVE_E2E_ROLLOUT_USER_IDS: 'staged' })), true, 'allowlisted');
  assert.equal(nativeEnabledFor('anyone', nativeRolloutFromEnv({ NATIVE_E2E_ROLLOUT_PERCENT: '100' })), true, 'full rollout');
  // A user whose bucket is below the percent is in; one above is out; the boundary is stable.
  const id = 'boundary-user';
  const bucket = nativeRolloutBucket(id);
  assert.equal(nativeEnabledFor(id, { percent: bucket, userIds: new Set() }), false, 'bucket == percent is out (bucket < percent)');
  assert.equal(nativeEnabledFor(id, { percent: bucket + 1, userIds: new Set() }), true, 'bucket < percent is in');
});
