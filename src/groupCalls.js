// L2, joinable group calls: the server tells every member who is in a group's call ("group:call", server/index.mjs),
// and the group shows it with "Join" for anyone not in it, like WhatsApp's ongoing group call.

/** groupId -> { roomId, mode, startedAt, participants } after one "group:call" event; an empty call is removed. */
export function applyGroupCall(current, event) {
  if (!event || typeof event.groupId !== 'string' || !event.groupId) return current;
  const participants = Array.isArray(event.participants) ? event.participants.filter((id) => typeof id === 'string') : [];
  if (!event.roomId || !participants.length) {
    if (!(event.groupId in current)) return current;
    const next = { ...current };
    delete next[event.groupId];
    return next;
  }
  return {
    ...current,
    [event.groupId]: { roomId: event.roomId, mode: event.mode === 'video' ? 'video' : 'audio', startedAt: event.startedAt ?? null, participants },
  };
}

/** What the group shows for its running call, or null: whether I am in it decides between "Join" and nothing. */
export function joinableGroupCall(groupCalls, groupId, userId) {
  const running = groupCalls?.[groupId];
  if (!running || running.participants.includes(userId)) return null;
  return running;
}

// How often a participant repeats that it is in the call (the server's GROUP_CALL_BEAT_MS).
export const GROUP_CALL_BEAT_MS = 30_000;

/** A group's chat-list row while a call I am not in runs there: the preview says so (opening it shows "Join"). */
export function withRunningCall(row, groupCalls, userId) {
  const running = joinableGroupCall(groupCalls, row.id, userId);
  return running ? { ...row, preview: `📞 ${running.mode === 'video' ? 'Video' : 'Voice'} call in progress · tap to join` } : row;
}
