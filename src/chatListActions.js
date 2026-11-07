// Actions offered when a chat row is long-pressed or right-clicked, and the wording around deleting threads.
import { isSavedContact } from './contactBook.js';

export function chatRowActions(chat, { pinned = false, muted = false, favourite = false } = {}) {
  return [
    { id: 'open', label: 'Open chat' },
    { id: 'pin', label: pinned ? 'Unpin chat' : 'Pin chat' },
    { id: 'mute', label: muted ? 'Unmute notifications' : 'Mute notifications' },
    { id: 'favourite', label: favourite ? 'Remove from favourites' : 'Add to favourites' },
    { id: 'select', label: 'Select chats' },
    { id: 'delete', label: 'Delete chat', danger: true },
  ];
}

export function deleteChatPrompt(chats) {
  const list = Array.isArray(chats) ? chats : [chats];
  if (list.length === 1) {
    const chat = list[0];
    const name = chat?.name ?? chat?.username ?? 'this contact';
    return {
      title: `Delete chat with ${name}?`,
      body: isSavedContact(chat)
        ? `Messages on this device and your Relay server copy are removed for you. ${name} stays in your contacts.`
        : `Messages on this device and your Relay server copy are removed for you. ${name} is not in your contacts, so the thread disappears until one of you messages again.`,
      confirm: 'Delete chat',
    };
  }
  return {
    title: `Delete ${list.length} chats?`,
    body: 'Messages in these chats are removed for you. Saved contacts stay in your contacts.',
    confirm: `Delete ${list.length} chats`,
  };
}

// Summarises a batch of delete attempts for the UI.
export function deleteOutcome(results) {
  const failed = results.filter((result) => result.status === 'rejected').length;
  if (!failed) return '';
  return failed === results.length
    ? 'Could not delete the chat. Check your connection and try again.'
    : `${failed} chat${failed > 1 ? 's' : ''} could not be deleted. Check your connection and try again.`;
}
