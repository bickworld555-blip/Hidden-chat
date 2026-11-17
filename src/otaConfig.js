// Over-the-air web updates (OTA): shared constants for the app, the server (server/otaUpdates.mjs) and the publisher
// (scripts/ota-publish.mjs). The Android side has the same values in OtaUpdates.java; a test keeps them equal.

// The native features a web bundle may rely on. Bump it (here and OtaUpdates.NATIVE_API) whenever a web change needs
// new native code (a new HiddenNative method, a manifest permission…): bundles published after that need the new APK,
// and older APKs keep their bundled copy instead of loading code they cannot run.
// 2: Sync phone contacts (HiddenNative.contactsPermission / requestContacts / readDeviceContacts).
export const NATIVE_API = 2;

// The public half of the OTA signing key (ECDSA P-256, SubjectPublicKeyInfo DER, base64). Phones accept a bundle only
// if its manifest is signed with the private half, which never leaves the publisher's machine
// (default C:\Users\<you>\.hidden-messenger\ota-signing-key.pem, or OTA_SIGNING_KEY): the server only stores and serves.
export const OTA_PUBLIC_KEY = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE9D5SrYnL+4D42UU1pHh0kmcGxT/Rjq6mhtbZUWeaIzFUXcFSgBht7WFLYKPYfyuy7yYY0Ld9hU4eRm8/BZyoxg==';

export const OTA_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,48}$/;
// Bundle paths: relative, plain characters, no "." or ".." segments.
export const OTA_PATH_PATTERN = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/;
export const OTA_MAX_FILES = 2000;
export const OTA_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const OTA_MAX_TOTAL_BYTES = 160 * 1024 * 1024;

/**
 * The manifest payload's facts, or null when it is not a valid one:
 * { version, nativeApi, createdAt, files: [{ path, sha256, size }] }.
 */
export function parseOtaPayload(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || !OTA_VERSION_PATTERN.test(value.version ?? '')) return null;
  if (!Number.isInteger(value.nativeApi) || value.nativeApi < 1 || !Number.isFinite(value.createdAt)) return null;
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > OTA_MAX_FILES) return null;
  const paths = new Set();
  let total = 0;
  for (const file of value.files) {
    if (!file || !OTA_PATH_PATTERN.test(file.path ?? '') || paths.has(file.path)) return null;
    if (!/^[0-9a-f]{64}$/.test(file.sha256 ?? '') || !Number.isInteger(file.size) || file.size < 0 || file.size > OTA_MAX_FILE_BYTES) return null;
    paths.add(file.path);
    total += file.size;
  }
  if (total > OTA_MAX_TOTAL_BYTES || !paths.has('index.html')) return null;
  return { version: value.version, nativeApi: value.nativeApi, createdAt: value.createdAt, files: value.files.map(({ path, sha256, size }) => ({ path, sha256, size })) };
}
