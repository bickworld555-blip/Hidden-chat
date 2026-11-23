// Rollout of the native Android end-to-end path (the Kotlin crypto core that replaces the hidden WebView page).
// Mirrors the XMPP rollout (server/xmpp.mjs): NATIVE_E2E_ROLLOUT_PERCENT (0-100, default 0) of accounts by a stable
// hash of the user id, plus everyone in NATIVE_E2E_ROLLOUT_USER_IDS (comma-separated, for staged/test accounts).
//
// Enabling the native path is a FORWARD migration: the device adopts a fresh native identity and re-registers, so the
// account's contacts see "security code changed". It is not cleanly reversible (reverting would be another identity
// change), so this gate is one-way by design: the kill-switch is "prevent new" — set the percent to 0 and/or remove
// ids from the allowlist to stop ANY MORE accounts migrating; accounts already moved over stay on the native path.
// The server only advertises eligibility (connection:ready `nativeE2e`); the app decides when to flip, once.
import { createHash } from 'node:crypto';

export function nativeRolloutFromEnv(env = process.env) {
  const percent = Number.parseInt(String(env.NATIVE_E2E_ROLLOUT_PERCENT ?? '0'), 10);
  return {
    percent: Number.isInteger(percent) ? Math.min(100, Math.max(0, percent)) : 0,
    userIds: new Set(String(env.NATIVE_E2E_ROLLOUT_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean)),
  };
}

/** A user's native-rollout bucket, 0-99: stable per account (its own salt, independent of the XMPP cohort). */
export function nativeRolloutBucket(userId) {
  return createHash('sha256').update(`native-e2e-rollout\n${userId}`).digest().readUInt32BE(0) % 100;
}

/** Whether this account is eligible for the native path under the current rollout (allowlist OR within the percent). */
export function nativeEnabledFor(userId, rollout = nativeRolloutFromEnv()) {
  if (!userId) return false;
  if (rollout.userIds.has(userId)) return true;
  return nativeRolloutBucket(userId) < rollout.percent;
}
