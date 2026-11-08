// Per-device group preferences (currently: muted groups), stored per signed-in account in localStorage.
// Muted groups keep their unread count but show a grey badge and do not count toward the app badge.
import { useEffect, useState } from 'react';

const EVENT = 'hm:group-prefs';
const key = (userId) => `hm:muted-groups:${userId}`;

export function readMutedGroups(userId, storage = globalThis.localStorage) {
  if (!userId || !storage) return [];
  try {
    const value = JSON.parse(storage.getItem(key(userId)) ?? '[]');
    return Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function setGroupMuted(userId, groupId, muted, storage = globalThis.localStorage) {
  const current = new Set(readMutedGroups(userId, storage));
  if (muted) current.add(groupId); else current.delete(groupId);
  storage?.setItem(key(userId), JSON.stringify([...current]));
  globalThis.dispatchEvent?.(new Event(EVENT));
  return [...current];
}

export function useMutedGroups(userId) {
  const [muted, setMuted] = useState(() => readMutedGroups(userId));
  useEffect(() => {
    const update = () => setMuted(readMutedGroups(userId));
    update();
    globalThis.addEventListener?.(EVENT, update);
    globalThis.addEventListener?.('storage', update);
    return () => {
      globalThis.removeEventListener?.(EVENT, update);
      globalThis.removeEventListener?.('storage', update);
    };
  }, [userId]);
  return muted;
}

// The group conversation currently on screen (one GroupsView at a time), so its alerts stay quiet.
let viewingGroupId = '';
export function setViewingGroup(groupId) { viewingGroupId = groupId || ''; }
export function getViewingGroup() { return viewingGroupId; }
