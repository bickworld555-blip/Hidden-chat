// Changes to stored group messages, whichever way they arrive: the server's own events for messages it stored
// (group:message-deleted, group:message-edited) and the events group controls produce for messages that travelled over
// XMPP (src/e2e/lifecycle.js: also group:message-reaction, group:message-played). One place applies them to this
// device's copy (src/store.js), so a delete for everyone removes the words on every member's device, and the group
// screen updates from the store without asking the server again.
import { isEnvelope } from './e2e/envelope.js';

export const GROUP_CHANGE_EVENTS = new Set(['group:message-deleted', 'group:message-edited', 'group:message-reaction', 'group:message-played']);

/** Applies one change event through the store; returns whether this device had the message. */
export function applyGroupChange(store, event) {
  if (!GROUP_CHANGE_EVENTS.has(event?.type) || typeof event.groupId !== 'string' || typeof event.messageId !== 'string') return false;
  const { groupId, messageId } = event;
  switch (event.type) {
    case 'group:message-deleted':
      return store.deleteGroupMessageForEveryone(groupId, messageId);
    case 'group:message-edited':
      // A server edit event carries the new words sealed; the group's history refresh opens those. A control's are open.
      if (typeof event.content !== 'string' || isEnvelope(event.content)) return false;
      return store.updateGroupMessage(groupId, messageId, (message) => (message.deleted ? message : { ...message, content: event.content, editedAt: event.editedAt ?? new Date().toISOString() }));
    case 'group:message-reaction':
      return store.updateGroupMessage(groupId, messageId, (message) => {
        const reactions = { ...(message.reactions && !Array.isArray(message.reactions) ? message.reactions : {}) };
        if (event.emoji) reactions[event.userId] = event.emoji; else delete reactions[event.userId];
        return { ...message, reactions };
      });
    case 'group:message-played':
      return store.updateGroupMessage(groupId, messageId, (message) => ({ ...message, played: true, playedBy: [...new Set([...(message.playedBy ?? []), event.userId])] }));
    default:
      return false;
  }
}
