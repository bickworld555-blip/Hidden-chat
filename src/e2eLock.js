// One writer at a time on the end-to-end state (IndexedDB) in the Android app: the app holds the "hm-e2e" Web Lock
// for as long as it runs, and the background page (src/background/main.js) only works when it can take that lock at
// once. When the app opens while the page is still finishing a message, the app waits here until the page lets go
// (Android also stops the page the moment the app's screen is created: BackgroundHost.stopForApp).
import { nativeShell } from './native.js';

export const E2E_LOCK = 'hm-e2e';
// Android destroys the page 3 s after asking it to stop, which releases its lock; this is only a last resort.
const LOCK_WAIT_MS = 8000;

/** Resolves true once the app holds the lock (it never releases it), or false where locks do not apply. */
export function holdE2eLock({ locks = globalThis.navigator?.locks, native = nativeShell(), timeoutMs = LOCK_WAIT_MS } = {}) {
  if (!native || !locks?.request) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    locks.request(E2E_LOCK, () => {
      clearTimeout(timer);
      resolve(true);
      return new Promise(() => {});
    }).catch(() => { clearTimeout(timer); resolve(false); });
  });
}

let held = null;
/** The app's one lock request (started on first use). */
export const e2eLockReady = () => (held ??= holdE2eLock());
