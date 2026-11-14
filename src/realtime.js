import { CLIENT_SUBPROTOCOL } from './clientVersion.js';
import { websocketUrl } from './api.js';
import { frameBytes, recordUsage } from './networkUsage.js';

// A phone that moves between Wi-Fi and mobile data keeps its old socket "open" while the connection under it is
// gone: nothing arrives, sends vanish, and the browser may not notice for minutes. The app therefore checks for
// itself (the server's own pings are invisible to JavaScript):
//   - on screen, a client:ping every PING_INTERVAL_MS; no frame of any kind within PONG_TIMEOUT_MS = dead;
//   - a sent message with no message:ack within ACK_TIMEOUT_MS triggers the same check at once;
//   - a network change (navigator.connection), coming back online, or the app returning to screen checks at once.
// A dead socket is abandoned without waiting for its closing handshake and a new one opens immediately; the
// outbox is replayed on connect (App.jsx onReady), so what was sent into the dead socket goes out again.
export const PING_INTERVAL_MS = 20_000;
export const PONG_TIMEOUT_MS = 8_000;
export const ACK_TIMEOUT_MS = 8_000;
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
    this.isIdle = false;
    this.visibility = document.visibilityState;
    this.lastActivity = Date.now();
    this.idleTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.ackTimer = null;
    this.awaitingAcks = new Map(); // message id -> when it was sent on the current socket
    this.listenersAttached = false;
    this.handleVisibility = () => {
      this.visibility = document.visibilityState;
      this.publishState();
      if (this.visibility === 'visible') this.wake();
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
    this.handleOnline = () => this.wake();
    this.handleNetworkChange = () => this.wake();
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
    if (this.closed) return;
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
   * The network may have changed or the app came back: check the socket now and, if none is open, connect now
   * (backoff starts over: the reason for the earlier failures may be gone).
   */
  wake() {
    if (this.closed) return;
    this.attempt = 0;
    if (this.socket?.readyState === WebSocket.OPEN) { this.probe(); return; }
    if (this.socket?.readyState === WebSocket.CONNECTING) return;
    if (navigator.onLine === false) return;
    this.connect();
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

  /** A message the server has not acknowledged for ACK_TIMEOUT_MS: check the socket now. */
  watchAcks() {
    if (this.ackTimer || !this.awaitingAcks.size) return;
    this.ackTimer = window.setTimeout(() => {
      this.ackTimer = null;
      const now = Date.now();
      for (const [id, sentAt] of this.awaitingAcks) if (now - sentAt > 5 * 60_000) this.awaitingAcks.delete(id);
      if ([...this.awaitingAcks.values()].some((sentAt) => now - sentAt >= ACK_TIMEOUT_MS)) this.probe();
      this.watchAcks();
    }, ACK_TIMEOUT_MS);
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
