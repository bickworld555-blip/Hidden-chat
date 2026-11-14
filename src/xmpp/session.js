// The app's XMPP session (Phase 3): only for accounts the server has moved over (GET /api/v1/xmpp/transport answers
// "xmpp"); everyone else never opens it. It sits beside the current realtime connection and takes over the traffic
// between devices, falling back to the current path whenever XMPP cannot carry something:
//
//   out  message:send     sealed envelope to every target device over XMPP (src/e2e/client.js xmppTargetsFor) when
//                         all of them have XMPP addresses; otherwise, or when XMPP refuses it, the current path.
//        queue:ack (sent by deliveryAck.js only once a message and its attachment are stored on this device) for
//        messages that came over XMPP: the XEP-0184 delivery receipt — so a sender's second tick means "stored on the
//        phone", and nothing is acknowledged that a crash could still lose. message:delivered for them is not sent.
//        message:read: XEP-0333 displayed. presence:typing (one-to-one): XEP-0085 chat states to the contact's devices.
//   in   a sealed message whose claimed sender owns the sending address (transport.js) and whose envelope names the
//        same sending device becomes the usual message:new; receipts and read markers become message:status; chat
//        states from a known device become presence:typing.
//
//   calls  the server stays in charge of a call's life: the first offer (ringing, the ring timeout, the call push that
//        wakes a phone, silencing unknown callers), the first answer (answered elsewhere) and every end (missed and
//        ended calls) go through it, each carrying this device's XMPP address (x). Once both sides know each other's
//        address, every other signal — ICE candidates, renegotiation and ICE-restart offers/answers, media state,
//        reactions — goes straight to the other call device over XMPP (live only); a refusal goes through the server.
//        Call invites are deliberately not stored on XMPP: a stored invite could ring after the call has ended.
//   groups a group message goes as one <fanout g=1 gid mh> to every member device when all have XMPP addresses
//        (ejabberd checks with the server that the sender may post and the members hash is current); when nobody
//        could be reached it is sent through the server instead, with the same message id.
//
//   changes  delete for everyone, edits, reactions and "played" on a message that travelled over XMPP (marked
//        via: 'xmpp' on every device) go as a sealed control message (sendControl; src/e2e/lifecycle.js): the server
//        never had that message. Messages the server stored keep the server's own path.
//   groups over XMPP are off unless `groupsOverXmpp`: their deletes, edits and reactions still go through the
//        server, which must therefore hold every group message until group controls exist.
//
// Everything else stays on the current connection for now (statuses, account, group admin).
import { parseEnvelope } from '../e2e/envelope.js';
import { XmppTransport } from './transport.js';

const RECEIPT_MEMORY = 5000;

/**
 * Resolves null unless this account is moved over. `deliver(event)` feeds the app's realtime event handler;
 * `legacySend(event)` is the current connection's send.
 */
export async function startXmppSession({ sessionToken, userId, deliver, legacySend, targetsFor, groupTargetsFor = async () => ({ targets: [], complete: false, sender: null }), userForAddress = () => null, fetchImpl, createTransport = (options) => new XmppTransport(options), seal = null, groupsOverXmpp = false }) {
  const auth = { Authorization: `Bearer ${sessionToken}` };
  let decision;
  try {
    const response = await fetchImpl('/api/v1/xmpp/transport', { headers: auth });
    decision = response.ok ? await response.json() : null;
  } catch {
    return null;
  }
  if (decision?.transport !== 'xmpp') return null;

  // Where the receipt for a message that came over XMPP goes (the sending device's full address).
  const cameFrom = new Map();
  // Messages sent over XMPP and not refused yet, so a refusal can resend them through the current path.
  const inFlight = new Map();
  const remember = (map, key, value) => { map.set(key, value); if (map.size > RECEIPT_MEMORY) map.delete(map.keys().next().value); };
  // Calls: callId -> { address, userId } of the other call device, learnt from the server-relayed offer/answer.
  const callPeers = new Map();
  const answeredThroughServer = new Set();
  const callSignalsInFlight = new Map();
  // Group messages sent over XMPP: id -> fallback() resending them through the server if nobody could be reached.
  const groupFallbacks = new Map();
  const CALL_ADDRESS = /^d[0-9a-f]{40}@[^/\s]+\/[^\s]{1,256}$/;
  const bare = (address) => String(address ?? '').split('/')[0];

  const transport = createTransport({
    fetchToken: async () => {
      const response = await fetchImpl('/api/v1/xmpp/token', { method: 'POST', headers: auth });
      if (response.ok || response.status === 409) return response.json();
      throw new Error(`XMPP sign-in token: HTTP ${response.status}`);
    },
    onEvent: (event) => {
      if (event.type === 'message') {
        const parsed = parseEnvelope(event.envelope);
        // The envelope must come from the device that sent the stanza (its ratchet is that device's).
        if (!parsed?.body || parsed.body.sd !== event.deviceId || !event.id) return;
        // A group stanza must carry a group envelope and a direct one a direct envelope (never one taken for the other).
        if (Boolean(event.group) !== Boolean(parsed.body.g)) return;
        remember(cameFrom, event.id, event.from);
        if (event.group) {
          if (!event.groupId) return;
          const createdAt = Date.parse(event.sentAt ?? '') || Date.now();
          deliver({ type: 'group:message', message: { id: event.id, groupId: event.groupId, senderId: event.userId, createdAt, content: event.envelope } });
          return;
        }
        deliver({
          type: 'message:new',
          message: { id: event.id, senderId: event.userId, receiverId: userId, content: event.envelope, timestamp: event.sentAt || new Date().toISOString(), status: 'sent', via: 'xmpp' },
        });
      } else if (event.type === 'receipt') {
        inFlight.delete(event.id);
        deliver({ type: 'message:status', messageId: event.id, status: 'delivered' });
      } else if (event.type === 'displayed') {
        deliver({ type: 'message:status', messageId: event.id, status: 'read' });
      } else if (event.type === 'call') {
        // Only from the device this call is with (learnt from the server-relayed offer or answer).
        const peer = callPeers.get(event.callId);
        if (!peer || bare(peer.address) !== bare(event.from)) return;
        deliver({ type: 'call:signal', from: peer.userId, callId: event.callId, mode: event.mode, signal: event.signal, signalId: event.signalId, ...(event.roomId ? { roomId: event.roomId } : {}) });
      } else if (event.type === 'fanout-ack') {
        const fallback = groupFallbacks.get(event.id);
        groupFallbacks.delete(event.id);
        if (fallback && event.delivered === 0) fallback();
      } else if (event.type === 'chatstate') {
        const sender = userForAddress(event.from);
        if (sender && sender !== userId) deliver({ type: 'presence:typing', userId: sender, active: event.state === 'composing', ...(event.state === 'composing' ? { kind: event.kind } : {}) });
      } else if (event.type === 'error' && callSignalsInFlight.has(event.id)) {
        const original = callSignalsInFlight.get(event.id);
        callSignalsInFlight.delete(event.id);
        legacySend(original);
      } else if (event.type === 'error' && inFlight.has(event.id)) {
        // Refused (e.g. someone moved back to the current path): that path delivers it instead.
        const original = inFlight.get(event.id);
        inFlight.delete(event.id);
        legacySend(original);
      }
    },
    onState: () => {},
  });

  async function sendMessage(event) {
    const message = event.message;
    try {
      const { targets, complete, sender } = await targetsFor(message.receiverId);
      if (!complete || !sender || transport.state !== 'online') return legacySend(event);
      remember(inFlight, message.id, event);
      transport.sendSealed({ id: message.id, to: targets, envelope: message.content, sender });
      // Sent: one tick, as the server's acknowledgement gives today.
      deliver({ type: 'message:ack', message: { ...message, senderId: userId, timestamp: message.timestamp || new Date().toISOString(), status: 'sent', via: 'xmpp' } });
    } catch {
      legacySend(event);
    }
  }

  async function sendTyping(event) {
    try {
      const { targets, complete } = await targetsFor(event.peerId, { peerOnly: true });
      if (!complete || transport.state !== 'online') return legacySend(event);
      for (const to of targets) transport.sendChatState(to, event.active ? 'composing' : 'paused', { kind: event.kind });
    } catch {
      legacySend(event);
    }
  }

  function routeCallSignal(event) {
    const { callId, signal } = event;
    if (signal.type === 'end') {
      callPeers.delete(callId);
      answeredThroughServer.delete(callId);
      return false;                                   // the server records how the call ended
    }
    if (signal.type === 'ringing') return false;
    const withAddress = { ...event, signal: { ...signal, x: transport.fullJid } };
    if (signal.type === 'offer' && !callPeers.has(callId)) { legacySend(withAddress); return true; }
    if (signal.type === 'answer' && !answeredThroughServer.has(callId)) {
      answeredThroughServer.add(callId);
      legacySend(withAddress);
      return true;
    }
    const peer = callPeers.get(callId);
    if (!peer) return false;
    const signalId = typeof event.signalId === 'string' ? event.signalId : crypto.randomUUID();
    if (!transport.sendCall(peer.address, { callId, mode: event.mode, roomId: event.roomId ?? null, signalId }, signal)) return false;
    remember(callSignalsInFlight, signalId, event);
    return true;
  }

  return {
    transport,
    /** A server-relayed call signal arrived: learn the other device's XMPP address (or forget the call when it ends). */
    observe(event) {
      if (event?.type !== 'call:signal' || typeof event.callId !== 'string') return;
      if (event.signal?.type === 'end') { callPeers.delete(event.callId); answeredThroughServer.delete(event.callId); return; }
      const address = event.signal?.x;
      // The address comes with the server-relayed, server-authenticated signal of that user, like the SDP itself.
      if (typeof address === 'string' && CALL_ADDRESS.test(address) && typeof event.from === 'string') callPeers.set(event.callId, { address, userId: event.from });
    },
    /**
     * Sends a sealed group message over XMPP when every member device can receive there. Resolves the row to show, or
     * null to send it through the server. `fallback()` resends through the server when nobody could be reached.
     */
    async sendGroup({ groupId, messageId, envelope, fallback }) {
      if (!groupsOverXmpp || transport.state !== 'online') return null;
      try {
        const { targets, complete, sender } = await groupTargetsFor(groupId);
        const membersHash = parseEnvelope(envelope)?.body?.mh;
        if (!complete || !sender || !membersHash || !targets.length) return null;
        if (fallback) remember(groupFallbacks, messageId, fallback);
        transport.sendSealed({ id: messageId, to: targets, envelope, sender, group: true, groupId, membersHash });
        return { id: messageId, groupId, senderId: userId, createdAt: Date.now(), content: envelope, expiresAt: null };
      } catch {
        return null;
      }
    },
    /**
     * Takes an outgoing realtime event if XMPP carries it: true when handled here (possibly falling back later),
     * false when the caller should send it on the current connection as usual.
     */
    route(event) {
      if (transport.state !== 'online' || !event || typeof event !== 'object') return false;
      if (event.type === 'message:send' && typeof event.message?.content === 'string' && event.message.content.startsWith('e2e2:') && event.message.receiverId) {
        sendMessage(event);
        return true;
      }
      // The receipt waits for local storage (queue:ack); the early "delivered" is not sent for XMPP messages.
      if (event.type === 'message:delivered' && Array.isArray(event.messageIds)) {
        const rest = event.messageIds.filter((id) => !cameFrom.has(id));
        if (rest.length) legacySend({ ...event, messageIds: rest });
        return true;
      }
      if (event.type === 'queue:ack' && Array.isArray(event.messageIds)) {
        const ours = event.messageIds.filter((id) => cameFrom.has(id));
        for (const id of ours) transport.sendReceipt(cameFrom.get(id), id);
        const rest = event.messageIds.filter((id) => !cameFrom.has(id));
        if (rest.length || event.eventIds?.length) legacySend({ ...event, messageIds: rest });
        return true;
      }
      if (event.type === 'call:signal' && event.signal && typeof event.callId === 'string') return routeCallSignal(event);
      if (event.type === 'presence:typing' && typeof event.peerId === 'string' && !event.groupId) {
        sendTyping(event);
        return true;
      }
      if (event.type === 'message:read' && cameFrom.has(event.messageId)) {
        transport.sendDisplayed(cameFrom.get(event.messageId), event.messageId);
        return true;
      }
      return false;
    },
    /**
     * A sealed change (src/e2e/lifecycle.js controlContent) to every device of both people in the chat with `peerId`.
     * Queued while the connection is down (Stream Management then resends it); false when it cannot go over XMPP.
     */
    async sendControl(peerId, content) {
      if (typeof seal !== 'function') return false;
      const { targets, complete, sender } = await targetsFor(peerId);
      if (!complete || !sender || !targets.length) return false;
      const envelope = await seal(peerId, content);
      if (typeof envelope !== 'string' || !envelope.startsWith('e2e2:')) return false;
      transport.sendSealed({ id: crypto.randomUUID(), to: targets, envelope, sender });
      return true;
    },
    setActive: (active) => transport.setActive(active),
    /** A wake-up push arrived (Android): connect now if the connection is down. */
    // A push, a network change or the app returning: check the connection now (src/xmpp/transport.js checkNow).
    wake: () => transport.checkNow(),
    close: () => transport.close(),
  };
}
