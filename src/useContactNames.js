// React side of src/contactNames.js: a resolver that re-renders when a contact is saved or renamed.
import { useCallback } from 'react';
import { useChatStore } from './store.js';
import { getContactDisplayName } from './contactNames.js';

/**
 * useContactNames() → nameOf(personOrId). Pass a group member or a message sender ({ id, name, username }) and
 * the saved name for that id wins over the name they go by; pass a bare id for someone only known by id.
 */
export function useContactNames() {
  const chats = useChatStore((state) => state.chats);
  const hiddenContacts = useChatStore((state) => state.hiddenContacts);
  const knownPeople = useChatStore((state) => state.knownPeople);
  return useCallback((personOrId) => {
    const id = typeof personOrId === 'string' ? personOrId : personOrId?.id;
    const fallback = personOrId && typeof personOrId === 'object' ? personOrId : null;
    return getContactDisplayName(id, { chats, hiddenContacts, knownPeople }, fallback);
  }, [chats, hiddenContacts, knownPeople]);
}

/** The shown name of one person, live. */
export function useContactDisplayName(id, fallback = null) {
  return useContactNames()(fallback ? { ...fallback, id } : id);
}
