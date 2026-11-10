// Notices shown inside a conversation and kept only on this device (never sent): e.g. a contact's security code
// changed because one of their devices got new keys.
export const NOTICE_PREFIX = 'notice:';
export const SECURITY_NOTICE = 'notice:security-code';

export const isNotice = (content) => typeof content === 'string' && content.startsWith(NOTICE_PREFIX);

export function noticeText(content, peerName = 'This contact') {
  if (content === SECURITY_NOTICE) return `${peerName}’s security code changed. Tap the contact’s info to verify it.`;
  return '';
}
