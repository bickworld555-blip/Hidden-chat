// Where end-to-end encryption meets the chat store and the realtime connection: every direct message leaves
// through transmitDirect (sealed for each device) and every server copy of a message is opened before the store
// sees it (live events, history, catch-up sync). Group messages are sealed and opened in GroupsView through
// client.js, with the same plaintext memory.
import { useChatStore } from '../store.js';
import { applyDeviceLists, e2eActive, isEnvelope, openContent, openDirectMessage, openDirectMessages, openGroupMessage, sealDirect } from './client.js';
import { isUserContent } from './envelope.js';

const MAX_RESEALS = 3;
const reseals = new Map();

function storedMessage(id, chatId = null) {
  const { messages } = useChatStore.getState();
  const lists = chatId ? [messages[chatId] ?? []] : Object.values(messages);
  for (const list of lists) {
    const found = list.find((message) => message.id === id);
    if (found) return found;
  }
  return null;
}

/**
 * Sends one direct message over the socket, sealed for the contact's devices and this account's other devices.
 * Only the id of a quoted message travels (the quote itself is shown from each device's own copy). Resolves
 * false when it could not be sealed or queued (the outbox sends it again on reconnect), and "waiting" when it is
 * held for end-to-end encryption (retried until the contact has keys).
 */
export async function transmitDirect(client, message, { fresh = false } = {}) {
  if (!client?.send || !message?.receiverId) return false;
  let content;
  try {
    content = await sealDirect(message.receiverId, message.content, {
      linkPreview: message.linkPreview, statusReply: message.statusReply, replyToId: message.replyTo?.id, forwarded: message.forwarded === true, caption: message.caption, album: message.album, thumb: message.thumb, poster: message.poster, duration: message.duration,
    }, { fresh: fresh || Boolean(message.awaitingKeys) });
  } catch (error) {
    // Strict end-to-end encryption: nothing people write is ever sent readable. When the contact has no keys yet
    // (an old app), the message waits in the outbox and goes out encrypted once they update.
    if (error?.code === 'peer-keys-missing') {
      useChatStore.getState().updateMessage(message.id, { status: 'waiting', awaitingKeys: true });
      return 'waiting';
    }
    return false;
  }
  // Not sealed (this device's encryption is not running yet): people's messages wait too; only call records and
  // this device's own markers may go as they are.
  if (!isEnvelope(content) && isUserContent(content)) {
    useChatStore.getState().updateMessage(message.id, { status: 'waiting', awaitingKeys: true });
    return 'waiting';
  }
  if (message.awaitingKeys) useChatStore.getState().updateMessage(message.id, { awaitingKeys: false, status: 'sent' });
  // The link preview, the quoted message and the forwarded mark only travel inside the encryption; a message that
  // could not be sealed (a call record) keeps its quote outside, as before.
  const { replyTo, forwarded, linkPreview: _preview, statusReply: _statusReply, awaitingKeys: _waiting, caption: _caption, album: _album, thumb: _thumb, poster: _poster, duration: _duration, ...rest } = message;
  const sealed = isEnvelope(content);
  return Boolean(client.send({ type: 'message:send', message: { ...rest, content,
    ...(!sealed && replyTo?.id ? { replyTo: { id: replyTo.id } } : {}), ...(!sealed && forwarded ? { forwarded: true } : {}) } }));
}

/** The server refused a sealed message because the device list changed: re-seal from the outbox and resend. */
export async function handleRejected(event, client) {
  if (event?.code !== 'e2e-devices' || !event.messageId) return false;
  applyDeviceLists(event.devices);
  const tries = (reseals.get(event.messageId) ?? 0) + 1;
  reseals.set(event.messageId, tries);
  if (tries > MAX_RESEALS) {
    useChatStore.getState().updateMessage(event.messageId, { status: 'failed' });
    return false;
  }
  const { userId, getOutbox } = useChatStore.getState();
  const queued = (await getOutbox(userId)).find((message) => message.id === event.messageId)
    ?? storedMessage(event.messageId, event.receiverId);
  if (!queued) return false;
  const { id, receiverId, content, replyTo, forwarded } = queued;
  return transmitDirect(client, { id, receiverId, content, ...(replyTo ? { replyTo } : {}), ...(forwarded ? { forwarded } : {}) });
}

const SEALED_EVENTS = new Set(['message:new', 'message:ack', 'message:edited', 'group:message', 'group:message-edited', 'message:reaction']);
const REACTION_PREFIX = 'reaction:';

/** An end-to-end encrypted reaction ("reaction:<emoji>" sealed per device) opened to its emoji; null if unreadable. */
export async function openReaction(emoji, reactorId) {
  if (!isEnvelope(emoji)) return emoji;
  const opened = await openContent(emoji, { senderId: reactorId });
  return opened.content?.startsWith(REACTION_PREFIX) ? opened.content.slice(REACTION_PREFIX.length) || null : null;
}

async function withOpenedReactions(message) {
  if (!Array.isArray(message?.reactions) || !message.reactions.some((reaction) => isEnvelope(reaction.emoji))) return message;
  const reactions = [];
  for (const reaction of message.reactions) {
    const emoji = await openReaction(reaction.emoji, reaction.userId);
    if (emoji) reactions.push({ ...reaction, emoji });
  }
  return { ...message, reactions };
}

const reactionRetries = new Map();
/**
 * Sends a reaction (or its removal, emoji null) to a direct message, sealed for every device like a message.
 * `peerId` is the other person in the chat. Re-seals when the server says the device list changed.
 */
export async function transmitReaction(client, peerId, messageId, emoji) {
  if (!client?.send) return false;
  let value = emoji;
  if (emoji) {
    try {
      value = await sealDirect(peerId, REACTION_PREFIX + emoji);
    } catch {
      return false;
    }
  }
  reactionRetries.set(messageId, { peerId, emoji, tries: reactionRetries.get(messageId)?.tries ?? 0 });
  return Boolean(client.send({ type: 'message:reaction', messageId, emoji: value }));
}

/** The server refused a sealed reaction because the device list changed: re-seal and send again (a few times). */
export function handleReactionError(event, client) {
  const pending = reactionRetries.get(event?.messageId);
  if (event?.code !== 'e2e-devices' || !pending || pending.tries >= MAX_RESEALS) return false;
  applyDeviceLists(event.devices);
  reactionRetries.set(event.messageId, { ...pending, tries: pending.tries + 1 });
  transmitReaction(client, pending.peerId, event.messageId, pending.emoji).catch(() => {});
  return true;
}

/** True for events that may carry ciphertext and must be opened (in arrival order) before they are handled. */
export const needsOpening = (event) => SEALED_EVENTS.has(event?.type);

/** The event with plaintext content (or e2eError); events without ciphertext come back unchanged. */
export async function openEvent(event) {
  if (event.type === 'message:new' || event.type === 'message:ack') {
    const message = await openDirectMessage(event.message, storedMessage(event.message?.id));
    // A message that arrived without end-to-end encryption while this device has it is marked "Not encrypted".
    const plain = event.type === 'message:new' && e2eActive() && !isEnvelope(event.message?.content) && isUserContent(event.message?.content);
    return { ...event, message: plain ? { ...message, unencrypted: true } : message };
  }
  if (event.type === 'message:reaction') {
    const sealed = isEnvelope(event.emoji);
    return { ...event, emoji: await openReaction(event.emoji, event.userId), ...(sealed ? { sealed: true } : {}) };
  }
  if (event.type === 'message:edited' && isEnvelope(event.content)) {
    const senderId = event.senderId ?? storedMessage(event.messageId)?.senderId;
    const opened = await openContent(event.content, { senderId });
    return { ...event, content: opened.content, ...(opened.e2eError ? { e2eError: opened.e2eError } : {}) };
  }
  if (event.type === 'group:message' && event.message) {
    return { ...event, message: await openGroupMessage(event.message.groupId, event.message) };
  }
  return event;
}

/** A chat's server history, opened in order; copies the store already reads correctly are kept. */
export async function openHistory(chatId, rows) {
  const known = new Map((useChatStore.getState().messages[chatId] ?? []).map((message) => [message.id, message]));
  const opened = await openDirectMessages(rows, (id) => known.get(id) ?? null);
  const out = [];
  for (const message of opened) out.push(await withOpenedReactions(message));
  return out;
}

/** Catch-up rows (any chat), opened in order. */
export function openRows(rows) {
  return openDirectMessages(rows, (id) => storedMessage(id));
}
