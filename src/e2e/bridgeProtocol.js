// The protocol object the web app uses in the native app: a drop-in for createProtocol (src/e2e/protocol.js) that
// runs every end-to-end operation in the native core over the Capacitor bridge (HiddenNativePlugin.crypto →
// NativeBridge → HmCryptoCore), so there is one identity and one ratchet per device, shared with background delivery.
//
// `call(method, args)` performs one bridge call and resolves the native reply ({ result } / { ok } / { error }); it
// is injected so this is unit-tested against the real JS protocol (server/bridge-protocol.test.mjs). The method names,
// argument shapes and results match protocol.js exactly. `digest` and `parseIdentity` stay in JS (pure, no keys).
// `storage` (the account key and list-join flag) is supplied by the caller and reconciled with the native
// registration; the crypto methods below never touch it.
import { fromBase64, sha256Hex, toBase64 } from './primitives.js';
import { parseIdentity } from './ratchet.js';

export function createBridgeProtocol(call, { storage = null } = {}) {
  const invoke = async (method, args = {}) => {
    const reply = await call(method, args);
    if (!reply) throw new Error('The native encryption core is not available.');
    if (reply.error) {
      const error = new Error(`native crypto: ${reply.error}`);
      error.code = reply.error;
      throw error;
    }
    return reply;
  };
  const value = (method, args) => invoke(method, args).then((reply) => reply.result);
  const unit = (method, args) => invoke(method, args).then(() => undefined);

  // Claim prekey bundles only for the devices the native core says have no session yet (so one-time prekeys are not
  // wasted on devices already established).
  async function bundlesFor(devices, claimBundles) {
    const missing = await value('missingSessions', { devices });
    const bundles = {};
    for (const [userId, ids] of Object.entries(missing ?? {})) if (ids?.length) bundles[userId] = await claimBundles(userId, ids);
    return bundles;
  }

  return {
    prepareUpload: ({ serverPreKeyCount = 0, now = Date.now() } = {}) => value('prepareUpload', { serverPreKeyCount, now }),
    publicIdentity: () => value('publicIdentity'),
    identityAgreement: async (publicKeyBytes) => fromBase64(await value('identityAgreement', { publicKey: toBase64(publicKeyBytes) })),

    encryptForDevices: async (devices, plaintext, { claimBundles }) =>
      value('encryptForDevices', { devices, plaintext, bundles: await bundlesFor(devices, claimBundles) }),
    decryptFromDevice: (userId, deviceId, entry) => value('decryptFromDevice', { userId, deviceId, entry }),
    forgetSession: (userId, deviceId) => unit('forgetSession', { userId, deviceId }),

    encryptGroup: async (groupId, me, memberDevices, plaintext, { claimBundles }) => {
      const targets = {};
      for (const [userId, ids] of Object.entries(memberDevices)) {
        const list = ids.filter((deviceId) => !(userId === me.userId && deviceId === me.deviceId)).map((deviceId) => ({ deviceId }));
        if (list.length) targets[userId] = list;
      }
      const bundles = await bundlesFor(targets, claimBundles);
      return value('encryptGroup', { groupId, meUserId: me.userId, meDeviceId: me.deviceId, memberDevices, plaintext, bundles });
    },
    confirmGroupSend: (groupId, keyId) => unit('confirmGroupSend', { groupId, keyId }),
    resetGroup: (groupId) => unit('resetGroup', { groupId }),
    decryptGroup: (groupId, me, userId, deviceId, body) => value('decryptGroup', { groupId, meUserId: me.userId, meDeviceId: me.deviceId, userId, deviceId, body }),

    safetyNumber: (mine, theirs) => value('safetyNumber', { mine, theirs }),
    signPreviewKey: (previewKey) => value('signPreviewKey', { previewKey }),

    digest: (text) => sha256Hex(text),
    parseIdentity,
    storage,
  };
}
