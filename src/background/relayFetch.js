// The background page's fetch for accounts on this server's relay (not on XMPP): connect as a background device
// (it never makes the person "online"), take what waited for this device, hand each message to `handle` (open, store,
// notify: src/background/main.js), and end once nothing more arrives. A push wakes it ("xwake",
// server/index.mjs pushToUser), so the notification shows the real text instead of a sealed "🔒 Message".
import { websocketUrl } from '../api.js';
import { CLIENT_SUBPROTOCOL } from '../clientVersion.js';

export const RELAY_FETCH_IDLE_MS = 2500;
export const RELAY_FETCH_MAX_MS = 15_000;
const HANDLED = new Set(['message:new', 'group:message']);

/**
 * Resolves with why it ended: "quiet" (the server sent what waited, then nothing for `idleMs`: everything was
 * handled), "offline" (no connection, or it closed before the server was ready), "limit" or "stopped".
 * `handle(event, send)` runs for each message in order; `send(event)` writes to the server (receipts, acks).
 */
export function relayFetch({ token, handle, createSocket = (url, protocols) => new WebSocket(url, protocols), url = websocketUrl(),
  idleMs = RELAY_FETCH_IDLE_MS, maxMs = RELAY_FETCH_MAX_MS, stop = { onStop: null }, log = () => {} }) {
  return new Promise((resolve) => {
    let socket;
    try {
      // relay.fetch: a background device that takes the messages itself (the Android service's own connection only
      // gets wake-ups for them on a phone like this: server/index.mjs wakeInsteadOf).
      socket = createSocket(url, [`relay.auth.${token}`, 'relay.v1', CLIENT_SUBPROTOCOL, 'relay.background', 'relay.fetch']);
    } catch (error) {
      log(`relay: ${error?.message ?? error}`);
      resolve('offline');
      return;
    }
    let ready = false;
    let ended = false;
    let chain = Promise.resolve();
    let idleTimer = null;
    const send = (event) => {
      try { socket.send(JSON.stringify(event)); return true; } catch { return false; }
    };
    const finish = async (reason) => {
      if (ended) return;
      ended = true;
      clearTimeout(idleTimer);
      clearTimeout(limitTimer);
      // What is being opened, stored and notified finishes first (its receipts and acks still go out).
      await chain.catch(() => {});
      try { socket.close(1000, 'background fetch done'); } catch { /* already closed */ }
      resolve(reason);
    };
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finish('quiet'), idleMs);
    };
    const limitTimer = setTimeout(() => finish('limit'), maxMs);
    stop.onStop = () => finish('stopped');
    socket.onmessage = (frame) => {
      let event;
      try { event = JSON.parse(typeof frame.data === 'string' ? frame.data : ''); } catch { return; }
      if (event?.type === 'connection:ready') ready = true;
      if (HANDLED.has(event?.type)) {
        chain = chain.then(() => handle(event, send)).catch((error) => log(`relay message: ${error?.message ?? error}`));
      }
      if (ready) armIdle();
    };
    socket.onclose = () => { if (!ended) finish(ready ? 'quiet' : 'offline'); };
    socket.onerror = () => { if (!ended && !ready) finish('offline'); };
  });
}
