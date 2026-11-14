// The app's connection to the XMPP core (ejabberd, chat.hiddenmessenger.com) — Phase 3 of the BEAM/XMPP move.
//
// Lifecycle: ask the server for a sign-in token (POST /api/v1/xmpp/token, refused with "legacy" for accounts not moved
// over), open wss://…/xmpp-websocket, authenticate with SASL PLAIN (the token is the password), bind, then enable
// Stream Management (XEP-0198) so a dropped connection resumes without losing or repeating stanzas: unacknowledged
// outbound stanzas are resent after a resume or a fresh session. Reconnects back off from 1 s to 30 s, with a new token
// every time (tokens live 10 minutes; a live session does not need one).
//
// What travels is what the app already seals: the end-to-end envelope, base64 in <hm xmlns='urn:hiddenmessenger:1'>,
// with the sender's user id (u) and device id (d). The receiver checks them against the address the stanza came from:
// a device address is "d" + SHA-256(userId \n deviceId)[0..40], so nobody can claim another user's identity.
// The server sees addresses and ciphertext only.
import { child, local, parseXml, xml } from './stanza.js';

export const NS_HM = 'urn:hiddenmessenger:1';
export const NS_FANOUT = 'urn:hiddenmessenger:fanout:1';
const NS_FRAMING = 'urn:ietf:params:xml:ns:xmpp-framing';
const NS_SASL = 'urn:ietf:params:xml:ns:xmpp-sasl';
const NS_BIND = 'urn:ietf:params:xml:ns:xmpp-bind';
const NS_SM = 'urn:xmpp:sm:3';
const NS_CSI = 'urn:xmpp:csi:0';
const NS_RECEIPTS = 'urn:xmpp:receipts';
const NS_MARKERS = 'urn:xmpp:chat-markers:0';
const NS_CHATSTATES = 'http://jabber.org/protocol/chatstates';
const NS_HINTS = 'urn:xmpp:hints';
const NS_DELAY = 'urn:xmpp:delay';
const CHAT_STATES = new Set(['active', 'composing', 'paused', 'inactive', 'gone']);
export const RECONNECT_MIN_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;
const ACK_REQUEST_MS = 5000;

const utf8 = new TextEncoder();
const toBase64 = (text) => { let s = ''; for (const byte of utf8.encode(text)) s += String.fromCharCode(byte); return btoa(s); };
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
const bareLocal = (jid) => String(jid ?? '').split('@')[0];

/** The XMPP localpart of a device: "d" + 40 hex of SHA-256(userId \n deviceId) (server/xmpp.mjs localpartFor). */
export async function deviceLocalpart(userId, deviceId, subtle = globalThis.crypto.subtle) {
  const digest = new Uint8Array(await subtle.digest('SHA-256', utf8.encode(`${userId}\n${deviceId}`)));
  return `d${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40)}`;
}

export class XmppTransport {
  /**
   * fetchToken(): resolves { transport, jid, token, websocket } (the token endpoint's answer) — "legacy" stops here.
   * onEvent(event): typed events (see #dispatch); onState(state): 'connecting' | 'online' | 'offline' | 'legacy' | 'closed'.
   */
  constructor({ fetchToken, onEvent = () => {}, onState = () => {}, createSocket = (url) => new WebSocket(url, 'xmpp'),
    setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), subtle = globalThis.crypto?.subtle,
    random = Math.random, resource = 'app' } = {}) {
    Object.assign(this, { fetchToken, onEvent, onState, createSocket, setTimer, clearTimer, subtle, random, resource });
    this.state = 'offline';
    this.closed = false;
    this.attempt = 0;
    this.socket = null;
    this.jid = null;          // bare address of this device
    this.fullJid = null;
    this.sm = { id: null, inbound: 0, acknowledged: 0, unacked: [], enabled: false };
    this.queue = [];          // stanzas waiting for a session
    this.ackTimer = null;
    this.retryTimer = null;
    this.active = true;
    // Incoming stanzas are handled one after another, in arrival order (checking a sender takes an async hash).
    this.dispatching = Promise.resolve();
  }

  #setState(state) {
    if (this.state === state) return;
    this.state = state;
    try { this.onState(state); } catch { /* listener's own failure */ }
  }

  async connect() {
    if (this.closed || this.state === 'connecting' || this.state === 'online') return;
    this.#setState('connecting');
    let grant;
    try {
      grant = await this.fetchToken();
    } catch {
      this.#scheduleReconnect();
      return;
    }
    if (this.closed) return;
    if (grant?.transport !== 'xmpp' || !grant.token || !grant.jid) {
      this.#setState('legacy');
      return;
    }
    if (this.jid && this.jid !== grant.jid) this.sm = { id: null, inbound: 0, acknowledged: 0, unacked: [], enabled: false };
    this.jid = grant.jid;
    this.#open(grant);
  }

  #open({ websocket, jid, token }) {
    const socket = this.createSocket(websocket);
    this.socket = socket;
    const host = jid.split('@')[1];
    let phase = 'open';
    const write = (markup) => socket.send(String(markup));
    const openStream = () => write(xml('open', { xmlns: NS_FRAMING, to: host, version: '1.0' }));
    socket.onopen = () => openStream();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimer(this.ackTimer);
      if (this.closed) return this.#setState('closed');
      this.#setState('offline');
      this.#scheduleReconnect();
    };
    socket.onerror = () => {};
    socket.onmessage = ({ data }) => {
      const el = parseXml(typeof data === 'string' ? data : '');
      if (!el) return;
      const name = local(el);
      if (name === 'open' || name === 'close') return;
      if (phase === 'open' && name === 'features') {
        phase = 'auth';
        return write(xml('auth', { xmlns: NS_SASL, mechanism: 'PLAIN' }, toBase64(`\0${bareLocal(jid)}\0${token}`)));
      }
      if (phase === 'auth') {
        if (name === 'success') { phase = 'restart'; return openStream(); }
        if (name === 'failure') { phase = 'failed'; return socket.close(); }
        return;
      }
      if (phase === 'restart' && name === 'features') {
        if (this.sm.id && child(el, 'sm', NS_SM)) {
          phase = 'resume';
          return write(xml('resume', { xmlns: NS_SM, h: this.sm.inbound, previd: this.sm.id }));
        }
        phase = 'bind';
        return write(xml('iq', { type: 'set', id: 'bind' }, xml('bind', { xmlns: NS_BIND }, xml('resource', {}, this.resource))));
      }
      if (phase === 'resume') {
        if (name === 'resumed') { this.#acked(Number(el.attrs.h)); phase = 'live'; return this.#online(true); }
        if (name === 'failed') {
          // The old session is gone: start a fresh one; anything it did not acknowledge is sent again.
          this.sm = { ...this.sm, id: null, inbound: 0, acknowledged: 0, enabled: false };
          phase = 'bind';
          return write(xml('iq', { type: 'set', id: 'bind' }, xml('bind', { xmlns: NS_BIND }, xml('resource', {}, this.resource))));
        }
        return;
      }
      if (phase === 'bind' && name === 'iq' && el.attrs.id === 'bind') {
        if (el.attrs.type !== 'result') return socket.close();
        this.fullJid = child(child(el, 'bind', NS_BIND), 'jid')?.text || `${jid}/${this.resource}`;
        phase = 'enable';
        return write(xml('enable', { xmlns: NS_SM, resume: 'true' }));
      }
      if (phase === 'enable') {
        // A new session counts from zero; stanzas the old one never acknowledged stay listed and are sent again.
        if (name === 'enabled') this.sm = { ...this.sm, id: el.attrs.resume === 'true' || el.attrs.resume === '1' ? el.attrs.id : null, inbound: 0, acknowledged: 0, enabled: true };
        phase = 'live';
        return this.#online(false);
      }
      if (phase !== 'live') return;
      if (name === 'r' && el.attrs.xmlns === NS_SM) return write(xml('a', { xmlns: NS_SM, h: this.sm.inbound }));
      if (name === 'a' && el.attrs.xmlns === NS_SM) return this.#acked(Number(el.attrs.h));
      if (name === 'message' || name === 'iq' || name === 'presence') {
        this.sm.inbound += 1;
        this.dispatching = this.dispatching.then(() => this.#dispatch(el)).catch(() => {});
      }
    };
  }

  #online(resumed) {
    this.attempt = 0;
    if (!resumed) this.socket.send(String(xml('presence')));
    this.socket.send(String(xml(this.active ? 'active' : 'inactive', { xmlns: NS_CSI })));
    this.#setState('online');
    // What the server never acknowledged goes again (it stays listed until acknowledged), then what waited offline.
    for (const markup of this.sm.unacked) this.socket.send(markup);
    const waiting = this.queue;
    this.queue = [];
    for (const markup of waiting) this.#write(markup);
    if (this.sm.unacked.length) this.socket.send(String(xml('r', { xmlns: NS_SM })));
  }

  // The server has handled h stanzas of this session: those leave the unacknowledged list.
  #acked(h) {
    if (!Number.isFinite(h)) return;
    const done = h - this.sm.acknowledged;
    if (done > 0) {
      this.sm.unacked.splice(0, done);
      this.sm.acknowledged = h;
    }
  }

  #write(markup) {
    if (this.state !== 'online' || !this.socket) { this.queue.push(markup); return false; }
    this.socket.send(markup);
    if (this.sm.enabled) {
      this.sm.unacked.push(markup);
      if (this.ackTimer === null) {
        this.ackTimer = this.setTimer(() => { this.ackTimer = null; this.socket?.send(String(xml('r', { xmlns: NS_SM }))); }, ACK_REQUEST_MS);
      }
    }
    return true;
  }

  #scheduleReconnect() {
    if (this.closed) return;
    this.clearTimer(this.retryTimer);
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.attempt) * (0.8 + 0.4 * this.random());
    this.attempt += 1;
    this.retryTimer = this.setTimer(() => { this.retryTimer = null; this.#setState('offline'); this.connect(); }, delay);
  }

  /** Foreground / background (XEP-0352): the server holds back non-urgent traffic for a phone in the background. */
  setActive(active) {
    this.active = Boolean(active);
    if (this.state === 'online') this.socket?.send(String(xml(this.active ? 'active' : 'inactive', { xmlns: NS_CSI })));
  }

  close() {
    this.closed = true;
    this.clearTimer(this.retryTimer);
    this.clearTimer(this.ackTimer);
    try { this.socket?.send(String(xml('close', { xmlns: NS_FRAMING }))); } catch { /* already gone */ }
    try { this.socket?.close(); } catch { /* already gone */ }
    this.#setState('closed');
  }

  // --- Sending (all queued while offline; Stream Management resends what the server did not acknowledge) ---------

  /**
   * One sealed envelope to one or more device addresses. Several go as one <fanout> the server splits (mod_hm), so
   * a group or multi-device message costs one stanza. `sender` = { userId, deviceId } of this device.
   */
  sendSealed({ id, to, envelope, sender, group = false }) {
    const targets = [...new Set(to)].filter(Boolean);
    if (!targets.length) return false;
    const payload = toBase64(envelope);
    if (targets.length === 1 && !group) {
      return this.#write(String(xml('message', { type: 'chat', id, to: targets[0] }, [
        xml('hm', { xmlns: NS_HM, v: '1', u: sender.userId, d: sender.deviceId }, payload),
        xml('request', { xmlns: NS_RECEIPTS }),
        xml('store', { xmlns: NS_HINTS }),
        xml('no-permanent-store', { xmlns: NS_HINTS }),
      ])));
    }
    const host = this.jid?.split('@')[1];
    return this.#write(String(xml('message', { id, to: host }, xml('fanout', { xmlns: NS_FANOUT, id, u: sender.userId, d: sender.deviceId, g: group ? '1' : '0' },
      targets.map((target) => xml('item', { to: bareLocal(target) }, payload))))));
  }

  /** Delivered (XEP-0184): sent once the message (and its media) is stored on this device. */
  sendReceipt(to, id) {
    return this.#write(String(xml('message', { to, id: `r-${id}` }, [xml('received', { xmlns: NS_RECEIPTS, id }), xml('store', { xmlns: NS_HINTS })])));
  }

  /** Read (XEP-0333 "displayed"). */
  sendDisplayed(to, id) {
    return this.#write(String(xml('message', { to, id: `d-${id}`, type: 'chat' }, [xml('displayed', { xmlns: NS_MARKERS, id }), xml('store', { xmlns: NS_HINTS })])));
  }

  /** Typing (XEP-0085): composing | paused | active. Never stored. */
  sendChatState(to, state) {
    if (!CHAT_STATES.has(state)) return false;
    return this.#write(String(xml('message', { to, type: 'chat' }, [xml(state, { xmlns: NS_CHATSTATES }), xml('no-store', { xmlns: NS_HINTS })])));
  }

  // --- Receiving -------------------------------------------------------------------------------------------------

  async #dispatch(el) {
    const name = local(el);
    const from = el.attrs.from ?? '';
    const emit = (event) => { try { this.onEvent(event); } catch { /* handler's own failure */ } };
    if (name === 'message' && el.attrs.type === 'error') {
      const error = child(el, 'error');
      return emit({ type: 'error', id: el.attrs.id ?? null, from, condition: error?.children?.[0] ? local(error.children[0]) : 'unknown' });
    }
    if (name !== 'message') return;
    const ack = child(el, 'fanout-ack', NS_FANOUT);
    if (ack) return emit({ type: 'fanout-ack', id: ack.attrs.id, delivered: Number(ack.attrs.n) || 0 });
    const received = child(el, 'received', NS_RECEIPTS);
    if (received) return emit({ type: 'receipt', id: received.attrs.id, from });
    const displayed = child(el, 'displayed', NS_MARKERS);
    if (displayed) return emit({ type: 'displayed', id: displayed.attrs.id, from });
    const hm = child(el, 'hm', NS_HM);
    if (hm) {
      const { u: userId, d: deviceId } = hm.attrs;
      // The claimed sender must own the address the stanza came from.
      if (!userId || !deviceId || !this.subtle || await deviceLocalpart(userId, deviceId, this.subtle) !== bareLocal(from)) {
        return emit({ type: 'rejected', id: el.attrs.id ?? null, from, reason: 'sender' });
      }
      let envelope;
      try { envelope = fromBase64(hm.text.trim()); } catch { return emit({ type: 'rejected', id: el.attrs.id ?? null, from, reason: 'payload' }); }
      const delay = child(el, 'delay', NS_DELAY)?.attrs.stamp ?? null;
      return emit({ type: 'message', id: el.attrs.id ?? null, from, userId, deviceId, envelope, group: hm.attrs.g === '1', sentAt: delay });
    }
    const state = el.children.find((item) => item.attrs.xmlns === NS_CHATSTATES && CHAT_STATES.has(local(item)));
    if (state) return emit({ type: 'chatstate', from, state: local(state) });
  }
}
