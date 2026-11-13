// Account-synced chat data (server/parity.mjs is the owner): starred messages, archived chats, labels, quick
// replies, pinned messages per chat and two-step status. Loaded when an account signs in, refreshed by socket
// events, and applied optimistically with rollback when the server refuses a change.
import { create } from 'zustand';
import * as api from './parityApi.js';
import { appSettings } from './settings.js';

export const groupChatKey = (groupId) => `group:${groupId}`;

const EMPTY = Object.freeze({ starred: {}, starsLoaded: false, starList: [], archived: [], labels: [], quickReplies: [], pins: {}, twoStep: null, loaded: false });

export const useAccountData = create(() => ({ ...EMPTY }));

let token = null;
let onStarsChanged = () => {};

const setState = (update) => useAccountData.setState(update);
const getState = () => useAccountData.getState();

/** The chat store mirrors stars on its messages; it registers how (src/store.js applyCloudStars). */
export function onCloudStars(listener) {
  onStarsChanged = listener;
}

async function loadStars() {
  const list = await api.listStars(token);
  const starred = Object.fromEntries(list.map((item) => [item.messageId, item.chatKey]));
  setState({ starList: list, starred, starsLoaded: true });
  onStarsChanged(starred);
}
const loadArchived = async () => setState({ archived: (await api.getChatPrefs(token)).archived });
const loadLabels = async () => setState({ labels: await api.listLabels(token) });
const loadQuickReplies = async () => setState({ quickReplies: await api.listQuickReplies(token) });
const loadTwoStep = async () => setState({ twoStep: await api.getTwoStep(token) });

/** Signs the data in (token) or out (null). Failures leave the previous values; the next event retries. */
export async function connectAccountData(sessionToken) {
  token = sessionToken;
  setState({ ...EMPTY });
  onStarsChanged(null);
  if (!sessionToken) return;
  const loaders = [loadStars, loadArchived, loadLabels, loadQuickReplies, loadTwoStep];
  await Promise.allSettled(loaders.map((load) => load()));
  if (token === sessionToken) setState({ loaded: true });
}

/** Socket events that change this data (sent to all of the account's devices). */
export function handleAccountEvent(event) {
  if (!token || typeof event?.type !== 'string') return;
  const ignore = () => {};
  if (event.type === 'stars:changed') loadStars().catch(ignore);
  else if (event.type === 'chat-prefs:changed') loadArchived().catch(ignore);
  else if (event.type === 'labels:changed') loadLabels().catch(ignore);
  else if (event.type === 'quick-replies:changed') loadQuickReplies().catch(ignore);
  else if (event.type === 'pins:changed') {
    const key = event.chatKey ?? null;
    const pins = getState().pins;
    // Group pins name their chat; a direct chat's pins name the pair, which is the peer from this side.
    const keys = key ? [key] : Object.keys(pins).filter((item) => (event.pairOf ?? []).includes(item));
    for (const chatKey of keys) loadPins(chatKey).catch(ignore);
  }
}

export async function toggleStar(messageId, chatKey, starred) {
  // Before the account's list has arrived there is nothing to update optimistically: save, then load it.
  if (!getState().starsLoaded) {
    await api.setStar(token, messageId, starred);
    return loadStars();
  }
  const previous = getState().starred;
  const next = { ...previous };
  if (starred) next[messageId] = chatKey;
  else delete next[messageId];
  setState({ starred: next });
  onStarsChanged(next);
  try {
    await api.setStar(token, messageId, starred);
    loadStars().catch(() => {});
  } catch (error) {
    setState({ starred: previous });
    onStarsChanged(previous);
    throw error;
  }
}

/** Stars kept only on this device before they followed the account are uploaded once. */
export async function uploadLocalStars(ids) {
  const known = getState().starred;
  for (const id of ids) if (!known[id]) await api.setStar(token, id, true).catch(() => {});
  if (ids.length) await loadStars().catch(() => {});
}

/**
 * Settings › Chats › Keep chats archived switched off (WhatsApp): a new message brings an archived chat back to the
 * chat list. On (the default) it stays archived.
 */
export function unarchiveOnMessage(chatKey) {
  if (!chatKey || appSettings().get('chats.keepArchived') || !getState().archived.includes(chatKey)) return;
  setChatArchived(chatKey, false).catch(() => {});
}

export async function setChatArchived(chatKey, archived) {
  const previous = getState().archived;
  setState({ archived: archived ? [...new Set([...previous, chatKey])] : previous.filter((key) => key !== chatKey) });
  try {
    await api.setArchived(token, chatKey, archived);
  } catch (error) {
    setState({ archived: previous });
    throw error;
  }
}

export async function loadPins(chatKey) {
  const pins = await api.listPins(token, chatKey);
  setState({ pins: { ...getState().pins, [chatKey]: pins } });
  return pins;
}

export async function setMessagePinned(chatKey, messageId, pinned) {
  await api.setPinned(token, chatKey, messageId, pinned);
  return loadPins(chatKey);
}

export async function toggleChatLabel(labelId, chatKey, assigned) {
  const previous = getState().labels;
  setState({ labels: previous.map((label) => (label.id === labelId
    ? { ...label, chatKeys: assigned ? [...new Set([...label.chatKeys, chatKey])] : label.chatKeys.filter((key) => key !== chatKey) }
    : label)) });
  try {
    await api.assignLabel(token, labelId, chatKey, assigned);
  } catch (error) {
    setState({ labels: previous });
    throw error;
  }
}

export const refreshLabels = () => loadLabels();
export const refreshQuickReplies = () => loadQuickReplies();
export const refreshTwoStep = () => loadTwoStep();

/** Quick replies whose shortcut starts with what follows "/" at the start of the draft. */
export function quickReplyMatches(draft, replies) {
  const match = /^\/([a-z0-9_]{0,25})$/i.exec(draft ?? '');
  if (!match) return [];
  const prefix = match[1].toLowerCase();
  return replies.filter((reply) => reply.shortcut.startsWith(prefix)).slice(0, 8);
}
