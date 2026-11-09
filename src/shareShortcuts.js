// Android app: your most recent chats become the top row of Android's share sheet (with their photos), like
// WhatsApp's. Re-published only when that list (or a name/photo in it) changes, and only while the app is on screen,
// because Android rate-limits shortcut updates from the background.
import { loadAvatar } from './avatar.js';
import { nativeSetShareTargets, nativeShell } from './native.js';
import { presentName } from './profile.js';
import { recentShareTargets } from './shareTarget.js';

// The chat list's avatar colours (styles.css .avatar-<color>): background and letters.
export const AVATAR_COLORS = {
  blue: ['#dfe6f3', '#4b5c82'],
  green: ['#deebe2', '#436b51'],
  coral: ['#f4e3dd', '#995d4c'],
  yellow: ['#f0ead8', '#7d6938'],
  violet: ['#e9e3ed', '#6a587b'],
};
const GROUP_COLORS = ['#8696a0', '#ffffff'];
const ICON_EDGE = 160;

// What Android needs for each shortcut (without the photo).
export function shareShortcutTargets(chats, groups, userId) {
  return recentShareTargets(chats, groups, userId).map((item) => {
    const name = item.kind === 'group' ? item.name ?? '' : presentName(item);
    const [color, textColor] = item.kind === 'group' ? GROUP_COLORS : AVATAR_COLORS[item.color] ?? AVATAR_COLORS.blue;
    const initials = item.kind === 'group' ? (name.trim()[0] ?? '#').toUpperCase() : item.initials ?? name.replace(/^@/, '').slice(0, 2).toUpperCase();
    return { kind: item.kind, id: item.id, name, initials, color, textColor, photo: item.kind === 'chat' ? item.avatar ?? '' : '' };
  }).filter((target) => target.name);
}

// A profile photo as a small square JPEG in base64, or '' when there is none or it cannot be read.
async function photoBase64(src, token) {
  if (!src || !token) return '';
  try {
    const url = await loadAvatar(src, token);
    const bitmap = await createImageBitmap(await (await fetch(url)).blob());
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = ICON_EDGE;
    canvas.height = ICON_EDGE;
    canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, ICON_EDGE, ICON_EDGE);
    return canvas.toDataURL('image/jpeg', 0.85).split(',')[1] ?? '';
  } catch {
    return '';
  }
}

let published = '';
export async function publishShareShortcuts({ chats, groups, userId, sessionToken }) {
  if (!nativeShell() || document.visibilityState !== 'visible') return;
  const targets = shareShortcutTargets(chats, groups, userId);
  const signature = JSON.stringify(targets);
  if (signature === published) return;
  published = signature;
  const withPhotos = await Promise.all(targets.map(async ({ photo, ...target }) => ({ ...target, avatar: await photoBase64(photo, sessionToken) })));
  const result = await nativeSetShareTargets(withPhotos);
  // Not accepted (older app, or Android rate-limited the update): try again on the next change.
  if (!result || (targets.length > 0 && !result.published)) published = '';
}

export function resetShareShortcutsForTests() {
  published = '';
}
