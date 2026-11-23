// Group conversations shown in the main chat list next to direct chats. The server's group listing
// (GET /api/v1/groups) owns unread counts and the latest message; this module only presents it.
import { previewFor } from './store.js';
import { formatChatListTime } from './time.js';

// "You: hi" for your own message, "Ava: hi" for someone else's, like a messenger group row.
export function groupPreviewText(group, userId) {
  if (!group?.lastContent) return 'No messages yet';
  const text = previewFor(group.lastContent);
  if (group.lastSenderId === userId) return `You: ${text}`;
  return group.lastSenderName ? `${group.lastSenderName}: ${text}` : text;
}

/**
 * The server's group listing carries the latest message's content as the stored envelope, which is end-to-end
 * encrypted — so the chat-list preview could only ever show "🔒 Message" (or "No messages yet" before the listing
 * caught up), never the real text, even though this device has already decrypted it. Overlay the newest locally
 * decrypted message so the group preview reads like a direct chat's. Ordering and unread stay the server's; the name
 * is kept only when the local last message is from the same sender the server named (the stored message has no name).
 */
export function withLocalPreview(group, lastLocal) {
  if (!group || !lastLocal || typeof lastLocal.content !== 'string' || !lastLocal.content) return group;
  const at = Number(lastLocal.createdAt);
  if (!Number.isFinite(at) || at < Number(group.lastMessageAt ?? 0)) return group;
  return {
    ...group,
    lastContent: lastLocal.content,
    lastSenderId: lastLocal.senderId,
    lastSenderName: lastLocal.senderId === group.lastSenderId ? group.lastSenderName : null,
    lastMessageAt: at,
  };
}

export function groupRow(group, userId, mutedIds = []) {
  const lastActivity = group.lastMessageAt ?? group.createdAt ?? null;
  return {
    kind: 'group',
    id: group.id,
    name: group.name,
    avatar: group.avatar ?? null,
    preview: groupPreviewText(group, userId),
    time: group.lastMessageAt ? formatChatListTime(group.lastMessageAt) : '',
    unread: Number(group.unread) || 0,
    muted: mutedIds.includes(group.id),
    lastActivityAt: lastActivity === null ? null : new Date(lastActivity).toISOString(),
  };
}

export function unreadBadge(count) {
  return count > 999 ? '999+' : String(count);
}

function activityTime(row) {
  const time = Date.parse(row?.lastActivityAt ?? '');
  return Number.isFinite(time) ? time : null;
}

// Keeps the direct-chat order for rows in `leadingIds` (pinned/favourite bands) at the top, then
// merges groups into the remaining chats by newest activity. Rows without activity go last.
export function mergeGroupRows(orderedChats, groupRows, { leadingIds = [] } = {}) {
  const leading = new Set(leadingIds);
  const head = orderedChats.filter((chat) => leading.has(chat.id));
  const rest = [...orderedChats.filter((chat) => !leading.has(chat.id)), ...groupRows]
    .map((row, index) => ({ row, index, time: activityTime(row) }))
    .sort((left, right) => {
      if (left.time === right.time) return left.index - right.index;
      if (left.time === null) return 1;
      if (right.time === null) return -1;
      return right.time - left.time;
    })
    .map(({ row }) => row);
  return [...head, ...rest];
}

// Muted groups keep their own (grey) badge but do not count toward navigation and app badges.
export function countUnreadConversations(chats, groups) {
  return [...chats, ...groups].reduce((sum, item) => sum + (item?.unread > 0 && !item.muted ? 1 : 0), 0);
}
