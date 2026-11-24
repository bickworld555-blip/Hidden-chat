import { CLIENT_SUBPROTOCOL } from './clientVersion.js';
import { websocketUrl } from './api.js';
import { frameBytes, recordUsage } from './networkUsage.js';

// A phone that moves between Wi-Fi and mobile data keeps its old socket "open" while the connection under it is
// gone: nothing arrives, sends vanish, and the browser may not notice for minutes. The app therefore checks for
// itself (the server's own pings are invisible to JavaScript):
//   - on screen, a client:ping every PING_INTERVAL_MS; no frame of any kind within PONG_TIMEOUT_MS = dead;
//   - a sent message with no message:ack within ACK_TIMEOUT_MS, and not a single frame since it was sent: the socket
//     is replaced at once (a slow but living socket, still sending frames, is only checked);
//   - coming back online, a change of network type (Wi-Fi <-> mobile), or the app returning to screen after a quiet
//     spell (STALE_AFTER_MS without a frame, or HIDDEN_STALE_MS in the background): replaced at once; otherwise checked.
// A replaced socket is abandoned without waiting for its closing handshake and a new one opens immediately; the
// outbox is replayed on connect (App.jsx onReady), so what was sent into the dead socket goes out again (the server
// answers a message id it already has with its ack, so nothing is stored or shown twice).
// Before: an unanswered message waited 8 s, then a ping 8 s more (8-16 s), and a return to screen pinged first.
export const PING_INTERVAL_MS = 20_000;
export const PONG_TIMEOUT_MS = 4_000;
export const ACK_TIMEOUT_MS = 3_000;
// A socket that has heard nothing for this long is not trusted when the app comes back (on screen it hears a pong
// every PING_INTERVAL_MS), nor after this long in the background.
export const STALE_AFTER_MS = PING_INTERVAL_MS + PONG_TIMEOUT_MS + 1_000;
export const HIDDEN_STALE_MS = 15_000;
// A drop that heals within this long is not shown as "Connecting…" (a Wi-Fi ↔ mobile data switch).
export const STATE_DEBOUNCE_MS = 3_000;

// Sends one event and counts it under Network usage › Messages.
function transmit(socket, event) {
  const frame = JSON.stringify(event);
  socket.send(frame);
  recordUsage('messages', { sent: frameBytes(frame), countSent: event?.type === 'message:send' ? 1 : 0 });
}

export class RealtimeClient {
  constructor(token, onEvent, onState) {
    this.token = token;
    this.onEvent = onEvent;
    this.reportState = onState;
    this.shownState = null;
    this.stateTimer = null;
    this.attempt = 0;
    this.queue = [];
    this.closed = false;
    this.retryTimer = null;
    this.socket = null;
    // When the native app owns the one foreground socket (NativeForegroundSocket), this client is SUSPENDED: it holds
    // no socket of its own and routes its outgoing frames to `onForward` (the native socket), so there is never a
    // second online connection decrypting the same messages. resume() revives it when native hands the socket back.
    this.suspended = false;
    this.onForward = null;
    // When native owns the one foreground socket (socket_owner), this is set true: the client then suspends itself
    // whenever the page is hidden (the native UI is in front and owns the socket) and resumes when visible again. Driven
    // by the page's OWN visibility, which fires reliably as the Activity pauses — not by a native push event that a
    // frozen WebView might never process.
    this.suspendWhenHidden = false;
    this.isIdle = false;
    this.visibility = document.visibilityState;
    this.lastActivity = Date.now();
    this.idleTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.ackTimer = null;
    this.awaitingAcks = new Map(); // message id -> when it was sent on the current socket
    this.lastFrameAt = 0; // when the current socket last received anything
    this.hiddenAt = this.visibility === 'visible' ? 0 : Date.now();
    this.networkType = navigator.connection?.type ?? null;
    this.listenersAttached = false;
    this.handleVisibility = () => {
      this.visibility = document.visibilityState;
      // socket_owner: native owns the socket while the native UI (hidden page) is in front. Close ours when hidden so
      // the two never both decrypt; reopen when the page is visible again (native UI closed). Outgoing goes to the
      // native socket via onForward meanwhile.
      if (this.suspendWhenHidden) {
        if (this.visibility === 'visible') { this.hiddenAt = 0; this.resume(); }
        else { this.hiddenAt = Date.now(); this.suspend(this.onForward); }
        return;
      }
      if (this.visibility === 'visible') {
        const hiddenFor = this.hiddenAt ? Date.now() - this.hiddenAt : 0;
        this.hiddenAt = 0;
        this.publishState();
        this.wake({ stale: hiddenFor > HIDDEN_STALE_MS });
      } else {
        this.hiddenAt = Date.now();
        this.publishState();
      }
      this.schedulePing();
    };
    this.handleActivity = () => {
      this.lastActivity = Date.now();
      if (this.isIdle) {
        this.isIdle = false;
        this.publishState();
      }
      this.scheduleIdle();
    };
    this.handleOffline = () => this.abandon('offline');
    // Back online: whatever socket survived belonged to the network that went away.
    this.handleOnline = () => this.wake({ stale: true });
    // A new network (Wi-Fi <-> mobile data): the old socket's route is gone. Other changes (a speed estimate) only check.
    this.handleNetworkChange = () => {
      const type = navigator.connection?.type ?? null;
      const switched = type !== this.networkType;
      this.networkType = type;
      this.wake({ stale: switched && type !== null });
    };
  }

  /** online at once; connecting/offline only once it has lasted STATE_DEBOUNCE_MS (or right away when `now`). */
  onState(state, now = false) {
    const show = (shown) => {
      window.clearTimeout(this.stateTimer);
      this.stateTimer = null;
      if (this.shownState === shown) return;
      this.shownState = shown;
      this.reportState(shown);
    };
    // Online, an explicit state, or nothing shown yet (the first connect): at once.
    if (state === 'online' || now || this.shownState === null) { show(state); return; }
    // Counted from the moment the connection was lost: later attempts update what will be shown, not when.
    this.pendingState = state;
    if (this.stateTimer || this.shownState === state) return;
    this.stateTimer = window.setTimeout(() => show(this.pendingState), STATE_DEBOUNCE_MS);
  }

  connect() {
    if (this.closed || this.suspended) return;
    window.clearTimeout(this.retryTimer);
    if (this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
    if (!this.listenersAttached) this.attachLifecycleListeners();
    const socket = new WebSocket(websocketUrl(), [`relay.auth.${this.token}`, 'relay.v1', CLIENT_SUBPROTOCOL]);
    this.socket = socket;
    this.onState('connecting');
    // A socket that never opens (a dead network during the handshake) is given up after a while too.
    const openTimer = window.setTimeout(() => { if (this.socket === socket && socket.readyState === WebSocket.CONNECTING) this.abandon('open timeout'); }, 15_000);
    socket.addEventListener('open', () => {
      window.clearTimeout(openTimer);
      if (this.socket !== socket) return;
      this.attempt = 0;
      this.lastFrameAt = Date.now();
      this.onState('online');
      this.publishState();
      this.schedulePing();
      this.onReady?.();
      while (this.queue.length && socket.readyState === WebSocket.OPEN) {
        const event = this.queue[0];
        try { this.transmit(socket, event); this.queue.shift(); }
        catch { break; }
      }
    });
    socket.addEventListener('message', ({ data }) => {
      if (this.socket !== socket) return;
      this.alive();
      let event;
      try { event = JSON.parse(data); } catch { return; /* Ignore malformed server events. */ }
      if (event?.type === 'pong') return;
      if (event?.type === 'message:ack' && event.message?.id) this.awaitingAcks.delete(event.message.id);
      if (event?.type === 'error' && event.messageId) this.awaitingAcks.delete(event.messageId);
      recordUsage('messages', { received: frameBytes(data), countReceived: event?.type === 'message:new' ? 1 : 0 });
      try { this.onEvent(event); } catch { /* a handler's own failure */ }
    });
    socket.addEventListener('close', (event) => {
      window.clearTimeout(openTimer);
      if (this.closed || this.socket !== socket) return;
      // 4001: this session was signed out (Log out, a password change, or Linked devices on another device).
      if (event.code === 4001) {
        this.closed = true;
        this.stopChecks();
        this.onState('offline', true);
        this.onRevoked?.(event.reason);
        return;
      }
      this.dropped();
    });
    socket.addEventListener('error', () => socket.close());
  }

  /** The current socket is gone (closed, or abandoned as dead): try again, at once the first time. */
  dropped() {
    this.stopChecks();
    this.socket = null;
    this.onState('offline');
    const delay = this.attempt === 0 ? 0 : Math.min(800 * 2 ** (this.attempt - 1), 20_000) + Math.random() * 350;
    this.attempt += 1;
    window.clearTimeout(this.retryTimer);
    if (navigator.onLine) this.retryTimer = window.setTimeout(() => this.connect(), delay);
    else this.onState('offline', true);
  }

  /** Gives up on the current socket without waiting for its closing handshake (which a dead network never ends). */
  abandon(reason) {
    if (this.closed) return;
    const socket = this.socket;
    if (socket) {
      this.socket = null;
      try { socket.close(4000, String(reason).slice(0, 60)); } catch { /* already closing */ }
    }
    this.dropped();
  }

  /**
   * The network may have changed or the app came back: an open socket that is `stale` (or has heard nothing for
   * STALE_AFTER_MS) is replaced now, a recent one is checked; with none open, connect now (backoff starts over: the
   * reason for the earlier failures may be gone).
   */
  wake({ stale = false } = {}) {
    if (this.closed) return;
    this.attempt = 0;
    if (this.socket?.readyState === WebSocket.OPEN) {
      if (stale || Date.now() - this.lastFrameAt > STALE_AFTER_MS) this.replace('stale');
      else this.probe();
      return;
    }
    if (this.socket?.readyState === WebSocket.CONNECTING) return;
    if (navigator.onLine === false) return;
    this.connect();
  }

  /** A new socket now, without asking the current one first; it is closed without waiting for its handshake. */
  replace(reason) {
    if (this.closed) return;
    this.attempt = 0;
    const old = this.socket;
    this.socket = null;
    this.stopChecks();
    if (old) { try { old.close(4000, String(reason).slice(0, 60)); } catch { /* already closing */ } }
    this.connect();
  }

  /**
   * A push says something waits and the app is in the background: a fresh connection now, without first asking the
   * old one for a pong. Android may have cut the old socket while it still reads as open, and a pong check takes
   * PONG_TIMEOUT_MS, longer than the phone stays awake for the push. The server then sends what waited at once.
   * Resolves when the new connection is ready (or after `timeoutMs`).
   */
  reconnectNow({ timeoutMs = 10_000 } = {}) {
    if (this.closed) return Promise.resolve(false);
    this.replace('push wake');
    const socket = this.socket;
    return new Promise((resolve) => {
      if (!socket) { resolve(false); return; }
      const timer = window.setTimeout(() => resolve(false), timeoutMs);
      socket.addEventListener('open', () => { window.clearTimeout(timer); resolve(true); }, { once: true });
      socket.addEventListener('close', () => { window.clearTimeout(timer); resolve(false); }, { once: true });
    });
  }

  /** Asks the server for a pong; no frame of any kind within PONG_TIMEOUT_MS means the socket is dead. */
  probe() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.pongTimer) return;
    try { socket.send(JSON.stringify({ type: 'client:ping' })); } catch { this.abandon('send failed'); return; }
    this.pongTimer = window.setTimeout(() => {
      this.pongTimer = null;
      if (this.socket === socket) this.abandon('no pong');
    }, PONG_TIMEOUT_MS);
  }

  /** Any frame from the server proves the socket works. */
  alive() {
    this.lastFrameAt = Date.now();
    window.clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  /** On screen: a ping every PING_INTERVAL_MS. In the background the phone may freeze timers; resuming checks. */
  schedulePing() {
    window.clearTimeout(this.pingTimer);
    this.pingTimer = null;
    if (this.closed || this.visibility !== 'visible') return;
    this.pingTimer = window.setTimeout(() => {
      this.probe();
      this.schedulePing();
    }, PING_INTERVAL_MS);
  }

  /**
   * A message the server has not acknowledged for ACK_TIMEOUT_MS: if the socket has heard nothing at all since that
   * message left, it is dead (writes into it vanish) and is replaced now; if frames still arrive, it is only slow, and
   * is checked. Checked again until every message is acknowledged.
   */
  watchAcks() {
    if (this.ackTimer || !this.awaitingAcks.size) return;
    const oldest = Math.min(...this.awaitingAcks.values());
    const wait = Math.max(250, oldest + ACK_TIMEOUT_MS - Date.now());
    this.ackTimer = window.setTimeout(() => {
      this.ackTimer = null;
      const now = Date.now();
      for (const [id, sentAt] of this.awaitingAcks) if (now - sentAt > 5 * 60_000) this.awaitingAcks.delete(id);
      const overdue = [...this.awaitingAcks.values()].filter((sentAt) => now - sentAt >= ACK_TIMEOUT_MS);
      if (overdue.length) {
        if (this.lastFrameAt <= Math.min(...overdue)) { this.replace('no ack'); return; }
        this.probe();
      }
      this.watchAcks();
    }, wait);
  }

  stopChecks() {
    window.clearTimeout(this.pingTimer);
    window.clearTimeout(this.pongTimer);
    window.clearTimeout(this.ackTimer);
    this.pingTimer = null;
    this.pongTimer = null;
    this.ackTimer = null;
    // The outbox replays unacknowledged messages on the next socket; they are watched again as they go out.
    this.awaitingAcks.clear();
  }

  transmit(socket, event) {
    transmit(socket, event);
    if (event?.type === 'message:send' && typeof event.message?.id === 'string') {
      this.awaitingAcks.set(event.message.id, Date.now());
      this.watchAcks();
    }
  }

  attachLifecycleListeners() {
    this.listenersAttached = true;
    document.addEventListener('visibilitychange', this.handleVisibility);
    for (const event of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(event, this.handleActivity, { passive: true });
    }
    window.addEventListener('offline', this.handleOffline);
    window.addEventListener('online', this.handleOnline);
    navigator.connection?.addEventListener?.('change', this.handleNetworkChange);
    this.scheduleIdle();
  }

  scheduleIdle() {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.isIdle = true;
      this.publishState();
    }, Math.max(1000, 60_000 - (Date.now() - this.lastActivity)));
  }

  publishState() {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    transmit(this.socket, {
      type: 'client:state',
      visibility: this.visibility,
      idle: this.isIdle,
    });
  }

  send(event) {
    // Suspended: the native socket is the only connection; hand the frame to it. With no forwarder yet, queue it so
    // resume() replays it (the same backpressure cap as the disconnected case).
    if (this.suspended) {
      if (this.onForward) {
        try { this.onForward(JSON.stringify(event)); return true; } catch { return false; }
      }
      if (this.queue.length >= 100) return false;
      this.queue.push(event);
      return true;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.transmit(this.socket, event);
        return true;
      } catch {
        if (this.queue.length >= 100) return false;
        this.queue.push(event);
        return true;
      }
    }
    if (this.queue.length >= 100) return false;
    this.queue.push(event);
    return true;
  }

  /**
   * The native app has taken ownership of the one foreground socket. Drop ours and stop reconnecting — WITHOUT the
   * terminal close() (resume() revives it) — so the two never decrypt the same message. Outgoing frames now go to
   * `onForward`. Idempotent.
   */
  suspend(onForward) {
    if (this.closed) return;
    this.onForward = onForward ?? this.onForward;
    if (this.suspended) return;
    this.suspended = true;
    this.stopChecks();
    window.clearTimeout(this.retryTimer);
    const old = this.socket;
    this.socket = null;
    this.onState('offline', true);
    if (old) { try { old.close(1000, 'native owns socket'); } catch { /* already closing */ } }
  }

  /** Native handed the socket back: reconnect ours and replay anything queued while suspended. */
  resume() {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    this.onForward = null;
    this.attempt = 0;
    this.connect();
  }

  /** A frame the native socket received and forwarded (a non-message event it does not own): handle it as our own. */
  inject(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'message:ack' && event.message?.id) this.awaitingAcks.delete(event.message.id);
    try { this.onEvent(event); } catch { /* a handler's own failure */ }
  }

  close() {
    this.closed = true;
    window.clearTimeout(this.retryTimer);
    window.clearTimeout(this.idleTimer);
    window.clearTimeout(this.stateTimer);
    this.stopChecks();
    if (this.listenersAttached) {
      document.removeEventListener('visibilitychange', this.handleVisibility);
      for (const event of ['pointerdown', 'keydown', 'touchstart']) {
        window.removeEventListener(event, this.handleActivity);
      }
      window.removeEventListener('offline', this.handleOffline);
      window.removeEventListener('online', this.handleOnline);
      navigator.connection?.removeEventListener?.('change', this.handleNetworkChange);
      this.listenersAttached = false;
    }
    this.socket?.close(1000, 'Client closed');
  }
}
