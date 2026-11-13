import { CLIENT_SUBPROTOCOL } from './clientVersion.js';
import { websocketUrl } from './api.js';
import { frameBytes, recordUsage } from './networkUsage.js';

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
    this.onState = onState;
    this.attempt = 0;
    this.queue = [];
    this.closed = false;
    this.retryTimer = null;
    this.socket = null;
    this.isIdle = false;
    this.visibility = document.visibilityState;
    this.lastActivity = Date.now();
    this.idleTimer = null;
    this.listenersAttached = false;
    this.handleVisibility = () => {
      this.visibility = document.visibilityState;
      this.publishState();
    };
    this.handleActivity = () => {
      this.lastActivity = Date.now();
      if (this.isIdle) {
        this.isIdle = false;
        this.publishState();
      }
      this.scheduleIdle();
    };
    this.handleOffline = () => this.socket?.close();
    this.handleOnline = () => {
      if (!this.closed && this.socket?.readyState !== WebSocket.OPEN && this.socket?.readyState !== WebSocket.CONNECTING) this.connect();
    };
  }

  connect() {
    if (this.closed) return;
    window.clearTimeout(this.retryTimer);
    if (this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
    if (!this.listenersAttached) this.attachLifecycleListeners();
    const socket = new WebSocket(websocketUrl(), [`relay.auth.${this.token}`, 'relay.v1', CLIENT_SUBPROTOCOL]);
    this.socket = socket;
    this.onState('connecting');
    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.onState('online');
      this.publishState();
      this.onReady?.();
      while (this.queue.length && socket.readyState === WebSocket.OPEN) {
        const event = this.queue[0];
        try { transmit(socket, event); this.queue.shift(); }
        catch { break; }
      }
    });
    socket.addEventListener('message', ({ data }) => {
      let event;
      try { event = JSON.parse(data); } catch { return; /* Ignore malformed server events. */ }
      recordUsage('messages', { received: frameBytes(data), countReceived: event?.type === 'message:new' ? 1 : 0 });
      try { this.onEvent(event); } catch { /* a handler's own failure */ }
    });
    socket.addEventListener('close', (event) => {
      if (this.closed) return;
      // 4001: this session was signed out (Log out, a password change, or Linked devices on another device).
      if (event.code === 4001) {
        this.closed = true;
        this.onState('offline');
        this.onRevoked?.(event.reason);
        return;
      }
      this.onState('offline');
      const delay = Math.min(800 * 2 ** this.attempt, 20_000) + Math.random() * 350;
      this.attempt += 1;
      if (navigator.onLine) this.retryTimer = window.setTimeout(() => this.connect(), delay);
      else this.onState('offline');
    });
    socket.addEventListener('error', () => socket.close());
  }

  attachLifecycleListeners() {
    this.listenersAttached = true;
    document.addEventListener('visibilitychange', this.handleVisibility);
    for (const event of ['pointerdown', 'keydown', 'touchstart']) {
      window.addEventListener(event, this.handleActivity, { passive: true });
    }
    window.addEventListener('offline', this.handleOffline);
    window.addEventListener('online', this.handleOnline);
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
        transmit(this.socket, event);
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
    if (this.listenersAttached) {
      document.removeEventListener('visibilitychange', this.handleVisibility);
      for (const event of ['pointerdown', 'keydown', 'touchstart']) {
        window.removeEventListener(event, this.handleActivity);
      }
      window.removeEventListener('offline', this.handleOffline);
      window.removeEventListener('online', this.handleOnline);
      this.listenersAttached = false;
    }
    this.socket?.close(1000, 'Client closed');
  }
}