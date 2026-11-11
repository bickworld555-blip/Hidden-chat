// How a group call carries media. Mesh: every participant connects to every other one (src/callRoom.js), which
// works without extra servers but makes each phone upload its video once per other person, so it is capped at
// MESH_MAX_PARTICIPANTS. SFU: everyone sends once to a media server that forwards to the rest (server/sfu.mjs
// issues the room tokens), which lifts the cap.
//
// The app's media client for the SFU is LiveKit's (src/components/call/GroupRelayCall.jsx, end-to-end encrypted
// with a key shared in the group's encrypted call card). The SFU itself is used only when the server advertises one.
export const MESH_MAX_PARTICIPANTS = 4;
export const SFU_MEDIA_CLIENT = true;

/** The server's answer from GET /api/v1/calls/topology, defaulting to mesh-only. */
export function parseTopology(value) {
  const meshMax = Number.isInteger(value?.meshMaxParticipants) ? value.meshMaxParticipants : MESH_MAX_PARTICIPANTS;
  const sfu = typeof value?.sfu?.url === 'string' && value.sfu.url.startsWith('wss://') && Number.isInteger(value.sfuMaxParticipants)
    ? { url: value.sfu.url, maxParticipants: value.sfuMaxParticipants }
    : null;
  return { meshMax, sfu };
}

/**
 * The plan for a call with `participants` people (me included): { topology: 'mesh' | 'sfu', capacity }.
 * Small calls stay on mesh (fewer hops, end-to-end DTLS between the phones); larger ones need the SFU.
 */
export function planCall(topology, participants, { mediaClient = SFU_MEDIA_CLIENT } = {}) {
  const { meshMax, sfu } = topology ?? parseTopology(null);
  const sfuUsable = Boolean(sfu && mediaClient);
  if (participants <= meshMax || !sfuUsable) return { topology: 'mesh', capacity: meshMax };
  return { topology: 'sfu', capacity: sfu.maxParticipants };
}

/** The most people a call can have right now. */
export function callCapacity(topology, options) {
  const { meshMax, sfu } = topology ?? parseTopology(null);
  return sfu && (options?.mediaClient ?? SFU_MEDIA_CLIENT) ? Math.max(meshMax, sfu.maxParticipants) : meshMax;
}
