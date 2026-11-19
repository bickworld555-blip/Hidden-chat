// The background page (background.html), run by Android in a hidden WebView when a push arrives and the app has no
// screen (BackgroundHost.java), like WhatsApp's GcmFGService:
//   1. only when it can take the "hm-e2e" lock at once (the app holds it while it runs: src/e2eLock.js);
//   2. opens this device's end-to-end keys (openE2eForBackground: no key publishing, no device-list sync) and the
//      app's encrypted database over Android's bridge (BackgroundSql.java), like WhatsApp's native code with
//      msgstore.db; the app's records are read as they are, and only the outbox is ever written
//      (backgroundSecureStorage);
//   3. connects to XMPP (or, for an account still on this server's relay, to the relay as a background device:
//      src/background/relayFetch.js) and takes what waited; each message is opened, then sealed with the Keystore into the inbox
//      (src/backgroundInbox.js) and written into the app's database (never over a copy already there) BEFORE the
//      server is told it was handled (the transport's ackAfterHandled) and before its delivery receipt goes;
//   4. posts the notification with the real text (Android applies mutes and locked chats);
//   5. once the server has given everything that waited, sends what the app left in its outbox (P6, like WhatsApp's
//      UnsentMessagesNetworkAvailableJob) and, when the server has them, takes them out of it and marks them sent;
//   6. ends the session cleanly (or when the app opens: window.__hmBgStop) and tells Android it is done.
// The app imports the inbox when it starts (unread counts, receipts, the chat list).
import { inboxKey, keepInInbox } from '../backgroundInbox.js';
import { openE2eForBackground, userForXmppAddress, xmppTargetsFor } from '../e2e/client.js';
import { openEvent, transmitDirect } from '../e2e/messaging.js';
import { apiFetch } from '../api.js';
import { backgroundSecureStorage, secureGet, secureSet, secureStorage, useSecureStorageOverride } from '../secureStorage.js';
import { createRecordTables, createSqliteMessageDb, openLocalDatabase, useLocalDatabaseConnector } from '../sqliteMessageDb.js';
import { groupMessageForStore, notificationPreview, useChatStore } from '../store.js';
import { groupChatKey } from '../accountData.js';
import { hiddenByBlock } from '../blocking.js';
import { startXmppSession } from '../xmpp/session.js';
import { holdsReceipts } from '../messageRequests.js';
import { E2E_LOCK } from '../e2eLock.js';
import { relayFetch } from './relayFetch.js';
import { acknowledgeable, attachmentToKeep } from '../deliveryAck.js';

const bridge = globalThis.HMBackground;
const log = (text) => { try { bridge?.log(String(text)); } catch { /* nothing to tell */ } };

let stopping = false;
let stopNow = null;
// The relay fetch's stop handle (it ends at once when the app opens).
const relayStop = { onStop: null };
// Android asks this when the app's screen is being created: finish the message in hand, then stop.
globalThis.__hmBgStop = () => { stopping = true; stopNow?.(); relayStop.onStop?.(); };

// The app's encrypted database over Android's bridge, with the calls src/sqliteMessageDb.js makes on the plugin's.
function bridgeDatabase() {
  const call = (request) => {
    const reply = JSON.parse(bridge.sql(JSON.stringify(request)) || '{"error":"no reply"}');
    if (reply.error) throw new Error(reply.error);
    return reply;
  };
  return {
    query: async (statement, values = []) => ({ values: call({ op: 'query', statement, values }).values ?? [] }),
    run: async (statement, values = [], transaction = true) => call({ op: 'run', statement, values, transaction }),
    execute: async (statement, transaction = true) => call({ op: 'execute', statement, transaction }),
    executeSet: async (set, transaction = true) => call({ op: 'executeSet', set, transaction }),
  };
}

/**
 * The app's database and records for this run; null when they cannot be opened (an app that never created them, an
 * older Android side): the page then keeps everything in memory as before and the inbox carries it all.
 */
async function openAppStorage(userId, outboxName) {
  if (typeof bridge.sql !== 'function' || typeof bridge.open !== 'function') return null;
  try {
    const db = bridgeDatabase();
    useLocalDatabaseConnector(async () => db);
    const platform = {
      seal: async (text) => { const sealed = bridge.seal(text); if (!sealed) throw new Error('not sealed'); return sealed; },
      open: async (sealed) => { const value = bridge.open(sealed); if (!value) throw new Error('not opened'); return value; },
    };
    useSecureStorageOverride(backgroundSecureStorage({ platform, tables: createRecordTables(openLocalDatabase), writable: (name) => name === outboxName }));
    await openLocalDatabase();
    return createSqliteMessageDb();
  } catch (error) {
    log(`database: ${error?.message ?? error}`);
    return null;
  }
}

async function run() {
  const raw = bridge.session();
  if (!raw) return 'signed-out';
  const { token, userId, deviceId } = JSON.parse(raw);
  const outboxName = `relay:outbox:${userId}`;
  const local = await openAppStorage(userId, outboxName);
  if (!local) {
    // Never the app's encrypted records: this page keeps what it would write in memory only.
    const memory = new Map();
    useSecureStorageOverride({ get: async (key) => memory.get(key), set: async (key, value) => { memory.set(key, value); }, del: async (key) => { memory.delete(key); }, ready: async () => 'memory' });
  }
  // The contacts (each chat's disappearing timer, for sealing the outbox) and blocks, read as the app saved them.
  const [chats, blocked] = local
    ? await Promise.all([secureGet(`relay:contacts:${userId}`), secureGet(`relay:blocked:${userId}`)]).catch(() => [null, null])
    : [null, null];
  useChatStore.setState({ userId, sessionToken: token, ...(Array.isArray(chats) ? { chats } : {}), ...(blocked && typeof blocked === 'object' && !Array.isArray(blocked) ? { blockedChats: blocked } : {}) });

  // A message this page opened goes into the app's database too (never over a copy already there); one from a
  // blocked person, or one it could not open, is left to the app (the inbox has it).
  const saveToDatabase = async (opened) => {
    const message = opened?.message;
    if (!local || !message?.id || message.e2eError) return false;
    if (opened.type === 'message:new') {
      const chat = message.senderId === userId ? message.receiverId : message.senderId;
      if (!chat || hiddenByBlock(message, useChatStore.getState().blockedChats?.[chat], userId)) return false;
      await local.addIfMissing(userId, [{ chat, message }]);
      return true;
    }
    if (opened.type === 'group:message' && message.groupId) {
      await local.addIfMissing(userId, [{ chat: groupChatKey(message.groupId), message: groupMessageForStore(message) }]);
      return true;
    }
    return false;
  };

  // P6: the outbox, sent once the server has given everything that waited (backgroundFetch's settle step).
  const acked = new Set();
  const refused = new Set();
  let session = null;
  const sendOutbox = async () => {
    if (!local || stopping || !session) return;
    const queued = (await secureGet(outboxName).catch(() => null)) ?? [];
    const sendable = queued.filter((message) => message?.id && message.receiverId && !message.awaitingKeys);
    if (!sendable.length) return;
    const client = { send: (event) => session.route(event) };
    for (const message of sendable) {
      if (stopping) break;
      if ((await transmitDirect(client, message).catch(() => false)) !== true) refused.add(message.id);
    }
    const settled = () => sendable.every((message) => acked.has(message.id) || refused.has(message.id));
    const deadline = Date.now() + 8000;
    while (!settled() && !stopping && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    const sent = sendable.filter((message) => acked.has(message.id)).map((message) => message.id);
    if (!sent.length) return;
    // The server answers this ping after every stanza sent before it: they are with the server (one tick).
    if (!(await session.transport.pingServer({ timeoutMs: 5000 }))) return;
    const now = (await secureGet(outboxName).catch(() => null)) ?? [];
    await secureSet(outboxName, now.filter((message) => !sent.includes(message?.id)));
    await local.setStatus(userId, sent, 'sent').catch((error) => log(`outbox status: ${error?.message ?? error}`));
    log(`outbox: ${sent.length} sent${refused.size ? `, ${refused.size} left` : ''}`);
  };

  const keep = async (event) => {
    const sealed = bridge.seal(JSON.stringify(event));
    if (!sealed) throw new Error('The Keystore did not seal it.');
    await keepInInbox(sealed, inboxKey(event?.message?.id ?? event?.type));
  };
  // A contact's new security code, met while the app was closed: shown when the app opens.
  const identityChanges = [];
  // With the app's records: its pinned device lists, so the outbox goes only where the app would send it.
  openE2eForBackground({ userId, deviceId, ...(local ? { token, records: { get: (key) => secureStorage().get(key), set: (key, value) => secureStorage().set(key, value) } } : {}), onIdentityChange: (change) => identityChanges.push({ type: 'identity-changed', ...change }) });

  // Receipts go back over the connection in use: the XMPP session, or the relay socket (relayFetch's `send`).
  let route = (event) => session?.route(event);
  const deliver = async (event) => {
    // One of the outbox's messages is on its way (src/xmpp/session.js sendMessage): see sendOutbox.
    if (event?.type === 'message:ack') { if (event.message?.id) acked.add(event.message.id); return; }
    // Stopping for the app: not handled, so the server keeps it for the app's own session.
    if (stopping) throw new Error('Stopping for the app.');
    const opened = await openEvent(event);
    // Marked opened: the app applies it as it is (src/App.jsx), never decrypting it a second time.
    await keep({ ...opened, opened: true });
    const saved = await saveToDatabase(opened).catch((error) => { log(`not in the database: ${error?.message ?? error}`); return false; });
    for (const change of identityChanges.splice(0)) await keep(change);
    const message = opened?.message;
    if (opened?.type === 'message:new' && message && message.senderId !== userId) {
      const body = message.e2eError ? '🔒 Message' : notificationPreview(message.content);
      bridge.notify(JSON.stringify({ kind: 'chat', from: message.senderId, body, messageId: message.id }));
      // Stored: now the sender's two grey ticks, from this phone.
      route({ type: 'message:delivered', messageIds: [message.id] });
    } else if (opened?.type === 'group:message' && message && message.senderId !== userId) {
      const body = message.e2eError ? '🔒 Message' : notificationPreview(message.content);
      bridge.notify(JSON.stringify({ kind: 'group', from: message.senderId, groupId: message.groupId, body, messageId: message.id }));
    }
    return { opened, saved };
  };

  session = await startXmppSession({
    sessionToken: token, userId, deliver,
    // Nothing else to send through: an outbox message XMPP cannot carry stays in the outbox for the app.
    legacySend: (event) => { if (event?.type === 'message:send' && event.message?.id) refused.add(event.message.id); return false; },
    targetsFor: local ? xmppTargetsFor : async () => ({ targets: [], complete: false, sender: null }),
    userForAddress: userForXmppAddress, fetchImpl: apiFetch,
    // Message requests (src/messageRequests.js): no receipts to someone unaccepted or not yet in the chat list.
    holdReceiptsFor: (peerId) => holdsReceipts(peerId, useChatStore.getState().chats),
    transportOptions: { ackAfterHandled: true },
  });
  if (!session) {
    // On this server's relay: the same opening, storing and notifying, over a background connection. A message is
    // acknowledged (the server may forget it for this device) only once it is readable and in the app's database,
    // with no attachment the app must still keep; anything else waits for the app as before.
    const reason = await relayFetch({
      token, stop: relayStop, log,
      handle: async (event, send) => {
        route = send;
        const { opened, saved } = await deliver(event);
        const message = opened?.message;
        if (saved && acknowledgeable(message) && !attachmentToKeep(event?.message?.content)) send({ type: 'queue:ack', messageIds: [message.id], eventIds: [] });
      },
    });
    if (stopping) return 'stopped-for-app';
    // "done" lets Android skip the sealed notice: the relay sent what waited and every message was handled.
    return reason === 'quiet' ? 'done' : `relay: ${reason}`;
  }

  let fetchReason = '';
  await new Promise((resolve) => {
    let finished = false;
    const finish = async (reason) => {
      if (finished) return;
      finished = true;
      fetchReason = reason;
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
    session.backgroundFetch({ stayOffline: () => true, settle: () => sendOutbox().catch((error) => log(`outbox: ${error?.message ?? error}`)) }).then((reason) => finish(reason));
  });
  // "done" only when it reached the server's end of what waits (Android then counts the fetch as complete and skips
  // the sealed notice); a time limit says so, and the sealed notice still covers a message it may not have reached.
  if (stopping) return 'stopped-for-app';
  return fetchReason === 'offline-done' || fetchReason === 'quiet' ? 'done' : `incomplete: ${fetchReason || 'unknown'}`;
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
