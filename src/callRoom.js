// Group-call room bookkeeping shared by the overlay, App routing and tests. A room is a set of
// pairwise 1:1 engines (full mesh); the server only relays invites and pair signals.

export const MAX_CALL_PARTICIPANTS = 4;

export function canInvite(peerCount) {
  // Me plus the current peers must leave room for one more.
  return peerCount + 1 < MAX_CALL_PARTICIPANTS;
}

// Whether a pair offer belongs to the room we are already in (then it joins silently, no ringing).
export function isRoomOffer(event, activeCall) {
  return Boolean(event?.roomId && activeCall?.roomId && event.roomId === activeCall.roomId && event.signal?.type === 'offer');
}

// The people a newcomer must connect to when accepting an invite: everyone listed, minus themselves.
export function peersToConnect(participants, selfId) {
  const unique = [];
  for (const id of participants ?? []) if (typeof id === 'string' && id && id !== selfId && !unique.includes(id)) unique.push(id);
  return unique.slice(0, MAX_CALL_PARTICIPANTS - 1);
}

// Keeps the extra engines of a room addressable both by peer and by their pair call id.
export class PeerRegistry {
  constructor() {
    this.byPeer = new Map();
    this.byCall = new Map();
  }

  add(peerId, callId, engine) {
    this.remove(peerId);
    const entry = { peerId, callId, engine };
    this.byPeer.set(peerId, entry);
    this.byCall.set(callId, entry);
    return entry;
  }

  remove(peerId) {
    const entry = this.byPeer.get(peerId);
    if (!entry) return null;
    this.byPeer.delete(peerId);
    this.byCall.delete(entry.callId);
    return entry;
  }

  forCall(callId) {
    return this.byCall.get(callId) ?? null;
  }

  forPeer(peerId) {
    return this.byPeer.get(peerId) ?? null;
  }

  get peerIds() {
    return [...this.byPeer.keys()];
  }

  get size() {
    return this.byPeer.size;
  }

  entries() {
    return [...this.byPeer.values()];
  }
}

// "Add people": the most-contacted people first (messages in the last 30 days plus calls, calls weighted),
// then everyone else alphabetically. `messages` is the store's chatId → messages map; `callLogs` its call log.
export const FREQUENT_LIMIT = 7;
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

export function rankCallContacts(contacts, { messages = {}, callLogs = [], now = Date.now() } = {}) {
  const score = new Map();
  for (const [chatId, list] of Object.entries(messages)) {
    const recent = (list ?? []).filter((message) => now - Date.parse(message.timestamp) < RECENT_MS).length;
    if (recent) score.set(chatId, (score.get(chatId) ?? 0) + recent);
  }
  for (const entry of callLogs) {
    if (entry?.peerId && now - Date.parse(entry.timestamp) < RECENT_MS) score.set(entry.peerId, (score.get(entry.peerId) ?? 0) + 5);
  }
  const label = (person) => String(person.name || person.username || '').toLocaleLowerCase();
  const byName = (a, b) => label(a).localeCompare(label(b));
  const frequent = contacts.filter((person) => score.get(person.id) > 0)
    .sort((a, b) => score.get(b.id) - score.get(a.id) || byName(a, b))
    .slice(0, FREQUENT_LIMIT);
  const others = contacts.filter((person) => !frequent.includes(person)).sort(byName);
  return { frequent, others };
}

export function matchesContact(person, query) {
  const needle = String(query ?? '').trim().toLocaleLowerCase();
  if (!needle) return true;
  return [person.name, person.username].some((value) => String(value ?? '').toLocaleLowerCase().includes(needle));
}
