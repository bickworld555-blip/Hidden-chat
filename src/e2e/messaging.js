// Where end-to-end encryption meets the chat store and the realtime connection: every direct message leaves
// through transmitDirect (sealed for each device) and every server copy of a message is opened before the store
// sees it (live events, history, catch-up sync). Group messages are sealed and opened in GroupsView through
// client.js, with the same plaintext memory.
import { useChatStore } from '../store.js';
import { forgetDeviceLists, e2eActive, isEnvelope, openContent, openDirectMessage, openDirectMessages, openGroupMessage, resealForDevice, sealDirect } from './client.js';
import { isUserContent } from './envelope.js';
import { controlContent, parseControl } from './lifecycle.js';
import { getXmppSession } from '../xmpp/active.js';

const MAX_RESEALS = 3;
const reseals = new Map();

export function storedMessage(id, chatId = null) {
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
    // The chat's disappearing timer goes inside the encryption, for a copy that never passes the server (XMPP).
    const disappearSeconds = useChatStore.getState().chats.find((chat) => chat.id === message.receiverId)?.disappearSeconds ?? 0;
    content = await sealDirect(message.receiverId, message.content, {
      linkPreview: message.linkPreview, statusReply: message.statusReply, replyToId: message.replyTo?.id, forwarded: message.forwarded === true, caption: message.caption, album: message.album, thumb: message.thumb, poster: message.poster, duration: message.duration, disappearSeconds,
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
  forgetDeviceLists(event.devices);
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

// --- "Waiting for this message": asking the sender to seal it again -------------------------------------------------
//
// A copy this device cannot open (sealed for another device, a lost or used-up one-time key, a broken session) is not
// left waiting forever: this device asks the device that sealed it (e2e:retry, through the server, carrying ids and
// the error only), and that device — which still holds the plaintext — seals it again for this device alone, starting
// a fresh session when the old one is unusable (message:reseal). The answer replaces "Waiting for this message".
// Asked at most RETRY_TRIES times per message, RETRY_SPACING_MS apart, and at most RETRY_PER_MINUTE requests a minute.
export const RETRY_TRIES = 3;
export const RETRY_SPACING_MS = 10 * 60 * 1000;
export const RETRY_PER_MINUTE = 30;
const retryAsked = new Map();   // message id -> { tries, at }
let retryWindow = { start: 0, count: 0 };
const answered = new Map();     // "messageId:userId:deviceId" -> times answered

/** True when a request went out for this message. `now` for tests. */
export function requestResend(client, message, { me = useChatStore.getState().userId, now = Date.now() } = {}) {
  if (!client?.send || !message?.e2eError || !message.sealedBy || typeof message.id !== 'string' || !message.senderId) return false;
  const previous = retryAsked.get(message.id);
  if (previous && (previous.tries >= RETRY_TRIES || now - previous.at < RETRY_SPACING_MS)) return false;
  if (now - retryWindow.start >= 60_000) retryWindow = { start: now, count: 0 };
  if (retryWindow.count >= RETRY_PER_MINUTE) return false;
  retryWindow.count += 1;
  retryAsked.set(message.id, { tries: (previous?.tries ?? 0) + 1, at: now });
  if (retryAsked.size > 5000) retryAsked.delete(retryAsked.keys().next().value);
  return Boolean(client.send({ type: 'e2e:retry', messageId: message.id, userId: message.senderId, senderDeviceId: message.sealedBy, error: String(message.e2eError).slice(0, 40), peerId: message.senderId === me ? message.receiverId : null }));
}

/**
 * Another device could not open a message: if this device sealed it and still holds it readable, seal it again for
 * that device and send it there. Only messages this account sent, only to the person they were sent to (or this
 * account's own other devices), at most RETRY_TRIES answers per message and device.
 */
export async function answerResendRequest(client, event, { me = useChatStore.getState().userId, deviceId = null } = {}) {
  if (!client?.send || typeof event?.messageId !== 'string' || typeof event.fromUserId !== 'string' || typeof event.fromDeviceId !== 'string') return false;
  if (deviceId && event.senderDeviceId && event.senderDeviceId !== deviceId) return false;     // another of my devices sealed it
  const message = storedMessage(event.messageId);
  if (!message || message.senderId !== me || message.e2eError || message.deleted || typeof message.content !== 'string' || !message.content) return false;
  if (event.fromUserId !== message.receiverId && event.fromUserId !== me) return false;
  const key = `${event.messageId}:${event.fromUserId}:${event.fromDeviceId}`;
  const times = answered.get(key) ?? 0;
  if (times >= RETRY_TRIES) return false;
  answered.set(key, times + 1);
  if (answered.size > 5000) answered.delete(answered.keys().next().value);
  const disappearSeconds = useChatStore.getState().chats.find((chat) => chat.id === message.receiverId)?.disappearSeconds ?? 0;
  const content = await resealForDevice(event.fromUserId, event.fromDeviceId, message.content, {
    linkPreview: message.linkPreview, statusReply: message.statusReply, replyToId: message.replyTo?.id, forwarded: message.forwarded === true,
    caption: message.caption, album: message.album, thumb: message.thumb, poster: message.poster, duration: message.duration, disappearSeconds,
  }, { error: event.error }).catch(() => null);
  if (!content) return false;
  return Boolean(client.send({ type: 'message:reseal', messageId: message.id, toUserId: event.fromUserId, toDeviceId: event.fromDeviceId, content }));
}

/** A copy sealed again for this device: opened; the readable message replaces "Waiting for this message". */
export async function applyResealed(event) {
  if (typeof event?.messageId !== 'string' || typeof event.content !== 'string' || !isEnvelope(event.content)) return null;
  const known = storedMessage(event.messageId);
  if (!known || !known.e2eError) return null;
  const opened = await openDirectMessage({ ...known, content: event.content, senderId: known.senderId }, null);
  if (!opened || opened.e2eError) return null;
  const { e2eError: _error, sealedBy: _sealedBy, ...rest } = opened;
  const fixed = { ...rest, e2eError: undefined, sealedBy: undefined };
  useChatStore.getState().addMessage(fixed);
  return fixed;
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

/**
 * A change to a message that travelled over XMPP (delete for everyone, edit, reaction, played) goes the same way, as a
 * sealed control to every device of both people (src/e2e/lifecycle.js): the server never had that message. True when
 * sent that way; false for a message the server stored, which keeps the server path. `change`: { op, emoji?, text? }.
 */
export function sendControlFor(target, change) {
  const session = getXmppSession();
  if (!session?.sendControl || target?.via !== 'xmpp' || typeof target.id !== 'string') return false;
  const me = useChatStore.getState().userId;
  const peerId = target.senderId === me ? target.receiverId : target.senderId;
  if (!peerId) return false;
  session.sendControl(peerId, controlContent({ ...change, target: target.id, peerId })).catch(() => {});
  return true;
}

const reactionRetries = new Map();
/**
 * Sends a reaction (or its removal, emoji null) to a direct message, sealed for every device like a message.
 * `peerId` is the other person in the chat. Re-seals when the server says the device list changed.
 */
export async function transmitReaction(client, peerId, messageId, emoji) {
  if (sendControlFor(storedMessage(messageId, peerId), { op: 'react', emoji: emoji || null })) return true;
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
  forgetDeviceLists(event.devices);
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
    // A sealed change to another message (src/e2e/lifecycle.js), never a message of its own. Only an XMPP copy can
    // carry one: the server path has its own events for these changes.
    if (event.type === 'message:new' && event.message?.via === 'xmpp' && typeof message?.content === 'string' && message.content.startsWith('ctl:')) {
      return { type: 'message:control', senderId: event.message.senderId, control: parseControl(message.content) };
    }
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
