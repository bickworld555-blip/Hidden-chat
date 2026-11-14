// The app's XMPP session (Phase 3): only for accounts the server has moved over (GET /api/v1/xmpp/transport answers
// "xmpp"); everyone else never opens it. It sits beside the current realtime connection and takes over the traffic
// between devices, falling back to the current path whenever XMPP cannot carry something:
//
//   out  message:send     sealed envelope to every target device over XMPP (src/e2e/client.js xmppTargetsFor) when
//                         all of them have XMPP addresses; otherwise, or when XMPP refuses it, the current path.
//        message:delivered / message:read for messages that came over XMPP: XEP-0184 receipt / XEP-0333 displayed.
//   in   a sealed message whose claimed sender owns the sending address (transport.js) and whose envelope names the
//        same sending device becomes the usual message:new; receipts and read markers become message:status.
//
// Everything else stays on the current connection for now (groups admin, statuses, account, calls, typing).
import { parseEnvelope } from '../e2e/envelope.js';
import { XmppTransport } from './transport.js';

const RECEIPT_MEMORY = 5000;

/**
 * Resolves null unless this account is moved over. `deliver(event)` feeds the app's realtime event handler;
 * `legacySend(event)` is the current connection's send.
 */
export async function startXmppSession({ sessionToken, userId, deliver, legacySend, targetsFor, fetchImpl, createTransport = (options) => new XmppTransport(options) }) {
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
        remember(cameFrom, event.id, event.from);
        deliver({
          type: 'message:new',
          message: { id: event.id, senderId: event.userId, receiverId: userId, content: event.envelope, timestamp: event.sentAt || new Date().toISOString(), status: 'sent' },
        });
      } else if (event.type === 'receipt') {
        inFlight.delete(event.id);
        deliver({ type: 'message:status', messageId: event.id, status: 'delivered' });
      } else if (event.type === 'displayed') {
        deliver({ type: 'message:status', messageId: event.id, status: 'read' });
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
      deliver({ type: 'message:ack', message: { ...message, senderId: userId, timestamp: message.timestamp || new Date().toISOString(), status: 'sent' } });
    } catch {
      legacySend(event);
    }
  }

  return {
    transport,
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
      if (event.type === 'message:delivered' && Array.isArray(event.messageIds)) {
        const ours = event.messageIds.filter((id) => cameFrom.has(id));
        for (const id of ours) transport.sendReceipt(cameFrom.get(id), id);
        const rest = event.messageIds.filter((id) => !cameFrom.has(id));
        if (rest.length) legacySend({ ...event, messageIds: rest });
        return true;
      }
      if (event.type === 'message:read' && cameFrom.has(event.messageId)) {
        transport.sendDisplayed(cameFrom.get(event.messageId), event.messageId);
        return true;
      }
      return false;
    },
    setActive: (active) => transport.setActive(active),
    close: () => transport.close(),
  };
}
