// Composer helpers: emoji tray contents and caret-aware insertion, shared by the chat input and tests.
import { EXTENDED_REACTIONS, QUICK_REACTIONS } from './reactions.js';

export const COMPOSER_EMOJIS = Object.freeze([...new Set([
  ...QUICK_REACTIONS,
  ...EXTENDED_REACTIONS,
  '😀', '😁', '😅', '🤣', '😊', '😇', '🙂', '😉', '😌', '😘', '😋', '😜',
  '🤗', '🤭', '🤫', '😏', '😒', '🙄', '😬', '😴', '🤒', '🥶', '😵', '🤯',
  '😳', '🥺', '😭', '😤', '😡', '🤬', '💀', '💩', '🤡', '👻', '👋', '👌',
  '✌️', '🤞', '🤟', '🤘', '👈', '👉', '👆', '👇', '☝️', '✋', '🤚', '🖐️',
  '👊', '✊', '🤛', '🤜', '💪', '🙌', '👐', '🤲', '💔', '💕', '💞', '💗',
  '💙', '💚', '💛', '🧡', '💜', '🖤', '🤍', '💯', '💢', '💥', '💫', '💦',
  '🌹', '🌸', '🌼', '🌻', '🍀', '🌈', '☀️', '🌙', '⭐', '⚡', '❄️', '🎂',
  '🍕', '🍔', '🍟', '🍩', '☕', '🍺', '🎁', '🎈', '🎶', '🏆', '⚽', '🚀',
])]);

export const COMPOSER_MAX_LENGTH = 4000;

// Inserts `emoji` at the caret (or replaces the current selection) and returns the new text and caret.
export function insertAtCaret(text, emoji, selectionStart, selectionEnd = selectionStart) {
  const source = String(text ?? '');
  const start = Number.isInteger(selectionStart) ? Math.max(0, Math.min(selectionStart, source.length)) : source.length;
  const end = Number.isInteger(selectionEnd) ? Math.max(start, Math.min(selectionEnd, source.length)) : start;
  const next = source.slice(0, start) + emoji + source.slice(end);
  if (next.length > COMPOSER_MAX_LENGTH) return { text: source, caret: end, inserted: false };
  return { text: next, caret: start + emoji.length, inserted: true };
}

// Which trailing action the composer shows: a voice note when the draft is empty, otherwise Send.
export function composerAction(text) {
  return String(text ?? '').trim() ? 'send' : 'voice';
}
