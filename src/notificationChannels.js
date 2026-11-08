// Notification channels: direct (1:1) and group messages are classified once here and then drive the
// sound category, the system-notification channel/tag and what opening the notification does.
// Browsers have no per-channel sound API, so the app plays each channel's tone itself.
import { previewFor } from './store.js';

export const NOTIFICATION_CHANNELS = Object.freeze({
  direct_messages: Object.freeze({ id: 'direct_messages', name: 'Direct Messages', category: 'message' }),
  group_messages: Object.freeze({ id: 'group_messages', name: 'Group Messages', category: 'group' }),
  reactions: Object.freeze({ id: 'reactions', name: 'Reactions', category: 'reaction' }),
});

export function channelForCategory(category) {
  if (category === 'group') return NOTIFICATION_CHANNELS.group_messages;
  if (category === 'reaction') return NOTIFICATION_CHANNELS.reactions;
  return NOTIFICATION_CHANNELS.direct_messages;
}

// Returns null for anything that should not alert (own messages, other event types).
export function classifyIncoming(event, userId) {
  if (event?.type === 'message:new' && event.message?.senderId && event.message.senderId !== userId) {
    return { isGroup: false, channel: NOTIFICATION_CHANNELS.direct_messages, conversation: { kind: 'chat', id: event.message.senderId } };
  }
  if (event?.type === 'group:message' && event.message?.groupId && event.message.senderId !== userId) {
    return { isGroup: true, channel: NOTIFICATION_CHANNELS.group_messages, conversation: { kind: 'group', id: event.message.groupId } };
  }
  return null;
}

// Group notification text: "<group>" / "<sender>: <preview>", like a messenger lock-screen entry.
export function groupNotificationText(event) {
  const preview = previewFor(event.message?.content ?? '');
  return {
    title: event.groupName || 'New group message',
    body: event.senderName ? `${event.senderName}: ${preview}` : preview,
  };
}

// A group alert is skipped when the group is muted on this device, or the person is already reading it.
export function shouldAlertGroup({ groupId, mutedGroupIds = [], viewingGroupId = '', pageVisible = false }) {
  if (mutedGroupIds.includes(groupId)) return false;
  return !(pageVisible && viewingGroupId === groupId);
}

// What a notification click should open, in a form that survives a service-worker postMessage or URL.
export function conversationOpenParam(conversation) {
  return conversation ? `${conversation.kind}:${conversation.id}` : '';
}

export function parseConversationOpenParam(value) {
  const match = /^(chat|group):(.{1,128})$/.exec(typeof value === 'string' ? value : '');
  return match ? { kind: match[1], id: match[2] } : null;
}
