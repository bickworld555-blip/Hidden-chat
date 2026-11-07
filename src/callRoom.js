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
