// The names the Android app's notifications show. Pushes carry ids only (server/push.mjs pushBody), so the phone
// names a chat from this map, which the app hands over with the session (HiddenNative.setSession → RelaySession,
// sealed with the Android Keystore). The names are the ones the person sees in the app.
import { presentName } from './profile.js';

export const MAX_NOTIFICATION_USERS = 3000;
export const MAX_NOTIFICATION_GROUPS = 1000;
const MAX_NAME_CHARS = 80;

const clean = (value) => (typeof value === 'string' ? value.trim().slice(0, MAX_NAME_CHARS) : '');

/** { users: {id: name}, groups: {id: name} } from the chat list and the group summaries. */
export function notificationNames(chats = [], groups = []) {
  const users = {};
  let userCount = 0;
  for (const chat of Array.isArray(chats) ? chats : []) {
    if (userCount >= MAX_NOTIFICATION_USERS) break;
    if (!chat || typeof chat.id !== 'string' || chat.isGroup) continue;
    const name = clean(presentName(chat) || chat.name);
    if (name && !(chat.id in users)) { users[chat.id] = name; userCount += 1; }
  }
  const groupNames = {};
  let groupCount = 0;
  for (const group of Array.isArray(groups) ? groups : []) {
    if (groupCount >= MAX_NOTIFICATION_GROUPS) break;
    const name = clean(group?.name);
    if (typeof group?.id === 'string' && name && !(group.id in groupNames)) { groupNames[group.id] = name; groupCount += 1; }
  }
  return { users, groups: groupNames };
}
