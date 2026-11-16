// The background page (background.html), run by Android in a hidden WebView when a push arrives and the app has no
// screen (BackgroundHost.java), like WhatsApp's GcmFGService:
//   1. only when it can take the "hm-e2e" lock at once (the app holds it while it runs: src/e2eLock.js);
//   2. opens this device's end-to-end keys for reading only (openE2eForBackground: no key publishing, no device-list
//      sync, nothing written to the app's encrypted records);
//   3. connects to XMPP and takes what waited; each message is opened, then sealed with the Keystore into the inbox
//      (src/backgroundInbox.js) BEFORE the server is told it was handled (the transport's ackAfterHandled) and
//      before its delivery receipt goes;
//   4. posts the notification with the real text (Android applies mutes and locked chats);
//   5. ends the session cleanly once quiet (or when the app opens: window.__hmBgStop) and tells Android it is done.
// The app imports the inbox when it starts.
import { inboxKey, keepInInbox } from '../backgroundInbox.js';
import { openE2eForBackground, userForXmppAddress } from '../e2e/client.js';
import { openEvent } from '../e2e/messaging.js';
import { apiFetch } from '../api.js';
import { useSecureStorageOverride } from '../secureStorage.js';
import { notificationPreview, useChatStore } from '../store.js';
import { startXmppSession } from '../xmpp/session.js';
import { E2E_LOCK } from '../e2eLock.js';

const bridge = globalThis.HMBackground;
const log = (text) => { try { bridge?.log(String(text)); } catch { /* nothing to tell */ } };

let stopping = false;
let stopNow = null;
// Android asks this when the app's screen is being created: finish the message in hand, then stop.
globalThis.__hmBgStop = () => { stopping = true; stopNow?.(); };

async function run() {
  const raw = bridge.session();
  if (!raw) return 'signed-out';
  const { token, userId, deviceId } = JSON.parse(raw);
  // Never the app's encrypted records: this page keeps what it would write in memory only.
  const memory = new Map();
  useSecureStorageOverride({ get: async (key) => memory.get(key), set: async (key, value) => { memory.set(key, value); }, del: async (key) => { memory.delete(key); }, ready: async () => 'memory' });
  useChatStore.setState({ userId, sessionToken: token });

  const keep = async (event) => {
    const sealed = bridge.seal(JSON.stringify(event));
    if (!sealed) throw new Error('The Keystore did not seal it.');
    await keepInInbox(sealed, inboxKey(event?.message?.id ?? event?.type));
  };
  // A contact's new security code, met while the app was closed: shown when the app opens.
  const identityChanges = [];
  openE2eForBackground({ userId, deviceId, onIdentityChange: (change) => identityChanges.push({ type: 'identity-changed', ...change }) });

  let session = null;
  const deliver = async (event) => {
    // Stopping for the app: not handled, so the server keeps it for the app's own session.
    if (stopping) throw new Error('Stopping for the app.');
    const opened = await openEvent(event);
    // Marked opened: the app applies it as it is (src/App.jsx), never decrypting it a second time.
    await keep({ ...opened, opened: true });
    for (const change of identityChanges.splice(0)) await keep(change);
    const message = opened?.message;
    if (opened?.type === 'message:new' && message && message.senderId !== userId) {
      const body = message.e2eError ? '🔒 Message' : notificationPreview(message.content);
      bridge.notify(JSON.stringify({ kind: 'chat', from: message.senderId, body, messageId: message.id }));
      // Stored: now the sender's two grey ticks, from this phone.
      session?.route({ type: 'message:delivered', messageIds: [message.id] });
    } else if (opened?.type === 'group:message' && message && message.senderId !== userId) {
      const body = message.e2eError ? '🔒 Message' : notificationPreview(message.content);
      bridge.notify(JSON.stringify({ kind: 'group', from: message.senderId, groupId: message.groupId, body, messageId: message.id }));
    }
  };

  session = await startXmppSession({
    sessionToken: token, userId, deliver, legacySend: () => false,
    targetsFor: async () => ({ targets: [], complete: false, sender: null }),
    userForAddress: userForXmppAddress, fetchImpl: apiFetch,
    transportOptions: { ackAfterHandled: true },
  });
  if (!session) return 'not-on-xmpp';

  await new Promise((resolve) => {
    let finished = false;
    const finish = async (reason) => {
      if (finished) return;
      finished = true;
      session.suspend();
      // Whatever is still being opened finishes (or is left unacknowledged for the app).
      await session.transport.dispatching.catch(() => {});
      log(`finished: ${reason}`);
      resolve();
    };
    stopNow = () => finish('stop-for-app');
    // Start from a clean, suspended state so the fetch connects and ends on the server's "that was everything" (its
    // ping reply comes after the last waiting message; this page's handlers store each one before it counts).
    session.suspend();
    session.backgroundFetch({ stayOffline: () => true }).then((reason) => finish(reason));
  });
  return stopping ? 'stopped-for-app' : 'done';
}

async function main() {
  if (!bridge) return;
  if (!globalThis.navigator?.locks?.request) { bridge.done('no-locks'); return; }
  let result = 'not-run';
  try {
    await navigator.locks.request(E2E_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) { result = 'app-holds-lock'; return; }
      result = await run();
    });
  } catch (error) {
    result = `failed: ${error?.message ?? error}`;
  }
  bridge.done(result);
}

main();
