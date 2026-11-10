// Client-side rules for the WhatsApp (Business) parity features: stickers, mentions, quick replies, edits, photo
// quality, encrypted backups and chat export, labels, archive actions and the new device settings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { STICKER_PACKS, isStickerContent, loadRecentStickers, parseSticker, rememberSticker, stickerContent, stickerPreview } from '../src/stickers.js';
import { activeMention, applyMention, mentionCandidates, mentionedUsernames, mentionsUser, splitMentions } from '../src/mentions.js';
import { BACKUP_FORMAT, buildBackupData, exportChatText, openBackup, sealBackup, validateBackupData } from '../src/backup.js';
import { canEditMessage, selectionActions } from '../src/selection.js';
import { isResizablePhoto, scaledSize } from '../src/mediaQuality.js';
import { chatRowActions, rowChatKey } from '../src/chatListActions.js';
import { labelColor, LABEL_PALETTE } from '../src/labels.js';
import { SECTIONS, SETTINGS, appLockDelayMs, createSettings, validSetting } from '../src/settings.js';
import { quickReplyMatches } from '../src/accountData.js';
import { inviteCodeFrom } from '../src/invites.js';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');
const memoryStorage = () => {
  const map = new Map();
  return { map, getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
};

test('stickers: content format, lookup, previews and recents', () => {
  const key = `${STICKER_PACKS[0].id}/${STICKER_PACKS[0].stickers[0].id}`;
  assert.equal(stickerContent(key), `sticker:${key}`);
  assert.equal(isStickerContent(stickerContent(key)), true);
  assert.equal(parseSticker(stickerContent(key)).emoji, STICKER_PACKS[0].stickers[0].emoji);
  assert.deepEqual(parseSticker('sticker:future/pack'), { unknown: true, key: 'future/pack' });
  assert.equal(parseSticker('hello'), null);
  assert.match(stickerPreview(stickerContent(key)), /Sticker$/);
  const storage = memoryStorage();
  rememberSticker('moods/lol', storage);
  rememberSticker('replies/ok', storage);
  rememberSticker('moods/lol', storage);
  storage.setItem('hm:sticker-recents', JSON.stringify([...JSON.parse(storage.getItem('hm:sticker-recents')), 'gone/x']));
  assert.deepEqual(loadRecentStickers(storage), ['moods/lol', 'replies/ok'], 'newest first, no duplicates, unknown dropped');
  const keys = STICKER_PACKS.flatMap((pack) => pack.stickers.map((item) => `${pack.id}/${item.id}`));
  assert.equal(new Set(keys).size, keys.length, 'sticker keys are unique');
});

test('mentions: suggestions at the caret, insertion, detection and highlighting', () => {
  assert.deepEqual(activeMention('Hi @an', 6), { start: 3, query: 'an' });
  assert.equal(activeMention('email a@b', 9), null, 'not inside a word');
  assert.equal(activeMention('Hi @ana done', 12), null);
  const members = [{ id: '1', username: 'ana', name: 'Ana' }, { id: '2', username: 'bob', name: 'Annabel' }, { id: '3', username: 'cy', name: 'Cy' }];
  assert.deepEqual(mentionCandidates(members, 'an', { excludeId: '3' }).map((member) => member.id), ['1', '2']);
  assert.deepEqual(applyMention('Hi @an!', { start: 3 }, 'ana', 6), { text: 'Hi @ana !', caret: 8 });
  assert.deepEqual(mentionedUsernames('@ana and @Bob, not a@b.com'), ['ana', 'bob']);
  assert.equal(mentionsUser('thanks @ANA.', 'ana'), true);
  assert.equal(mentionsUser('thanks @anabel', 'ana'), false);
  assert.deepEqual(splitMentions('Hi @ana and @ghost', ['ana']), [{ text: 'Hi ' }, { mention: '@ana', username: 'ana' }, { text: ' and @ghost' }]);
});

test('quick replies match "/" shortcuts at the start of the draft only', () => {
  const replies = [{ id: 'a', shortcut: 'thanks', text: 'Thank you!' }, { id: 'b', shortcut: 'hours', text: '9–5' }, { id: 'c', shortcut: 'thx', text: 'ty' }];
  assert.deepEqual(quickReplyMatches('/th', replies).map((reply) => reply.id), ['a', 'c']);
  assert.equal(quickReplyMatches('/', replies).length, 3);
  assert.deepEqual(quickReplyMatches('say /th', replies), []);
  assert.deepEqual(quickReplyMatches('/th ', replies), []);
});

test('edits: own text messages for 15 minutes; not stickers, media or deleted messages', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const base = { id: 'm', senderId: 'me', content: 'hello', timestamp: '2026-11-10T11:50:00Z' };
  assert.equal(canEditMessage(base, 'me', now), true);
  assert.equal(canEditMessage({ ...base, timestamp: '2026-11-10T11:40:00Z' }, 'me', now), false, 'after 15 minutes');
  assert.equal(canEditMessage(base, 'you', now), false);
  assert.equal(canEditMessage({ ...base, content: 'sticker:moods/lol' }, 'me', now), false);
  assert.equal(canEditMessage({ ...base, content: 'media:x:a.jpg' }, 'me', now), false);
  assert.equal(canEditMessage({ ...base, deleted: true }, 'me', now), false);
  assert.equal(canEditMessage({ id: 'g', senderId: 'me', content: 'group', createdAt: now - 60_000 }, 'me', now), true, 'group messages carry createdAt');
  const actions = selectionActions([base], 'me', now);
  assert.equal(actions.canEdit, true);
  assert.equal(actions.canPin, true);
  assert.equal(selectionActions([base, { ...base, id: 'n' }], 'me', now).canEdit, false);
});

test('photo quality: only photos are resized, keeping the aspect ratio', () => {
  assert.equal(isResizablePhoto('image/jpeg'), true);
  assert.equal(isResizablePhoto('image/gif'), false, 'animations are kept');
  assert.equal(isResizablePhoto('video/mp4'), false);
  assert.deepEqual(scaledSize(4000, 3000, 1600), { width: 1600, height: 1200 });
  assert.deepEqual(scaledSize(1000, 3000, 1600), { width: 533, height: 1600 });
  assert.equal(scaledSize(1200, 900, 1600), null);
});

test('backups are encrypted with the password, tamper-evident and checked before restoring', async () => {
  const data = buildBackupData({
    user: { id: 'u1', username: 'ana', name: 'Ana' },
    chats: [{ id: 'p1', username: 'bob', name: 'Bob', extra: 'dropped' }],
    messages: { p1: [{ id: 'm1', senderId: 'u1', receiverId: 'p1', timestamp: '2026-11-10T10:00:00Z', content: 'secret text' }] },
    callLogs: [],
    preferences: { pinnedChatIds: ['p1'] },
    groups: [],
  });
  assert.deepEqual(Object.keys(data.chats[0]).sort(), ['color', 'id', 'initials', 'name', 'saved', 'username'], 'only the chat fields a restore needs');
  const file = await sealBackup(data, 'correct horse', { rounds: 100_000 });
  assert.equal(JSON.parse(file).format, BACKUP_FORMAT);
  assert.equal(file.includes('secret text'), false, 'nothing readable in the file');
  assert.deepEqual(await openBackup(file, 'correct horse'), JSON.parse(JSON.stringify(data)));
  await assert.rejects(openBackup(file, 'wrong password'), /Wrong password/);
  const tampered = JSON.parse(file);
  tampered.kdf.rounds = 100_001;
  await assert.rejects(openBackup(JSON.stringify(tampered), 'correct horse'), /Wrong password|damaged/);
  await assert.rejects(openBackup('{"hello":1}', 'x'), /not a Hidden Messenger backup/);
  await assert.rejects(sealBackup(data, 'short'), /at least 8/);
  assert.throws(() => validateBackupData(data, 'someone-else'), /belongs to @ana/);
  assert.equal(validateBackupData(data, 'u1'), data);
  assert.throws(() => validateBackupData({ ...data, messages: { p1: [{ id: 1 }] } }, 'u1'), /damaged/);
});

test('chat export: one line per message, edits marked, deleted messages left out', () => {
  const text = exportChatText({
    title: 'Bob',
    messages: [
      { id: '1', senderId: 'me', timestamp: '2026-11-10T09:05:00Z', content: 'Hi', editedAt: '2026-11-10T09:06:00Z' },
      { id: '2', senderId: 'bob', timestamp: '2026-11-10T09:07:00Z', content: 'gone', deleted: true },
      { id: '3', senderId: 'bob', timestamp: '2026-11-10T09:08:00Z', content: 'sticker:moods/lol' },
    ],
    nameFor: (id) => (id === 'me' ? 'You' : 'Bob'),
    describe: (content) => (content.startsWith('sticker:') ? 'Sticker' : content),
  });
  const lines = text.trim().split('\n');
  assert.equal(lines[0], 'Chat with Bob');
  assert.match(lines[3], / - You: Hi <This message was edited>$/);
  assert.match(lines[4], / - Bob: Sticker$/);
  assert.equal(lines.length, 5);
});

test('chat rows: archive and label actions; group rows use "group:<id>" keys', () => {
  assert.deepEqual(chatRowActions({ id: 'p' }, { archived: true }).map((action) => action.id), ['open', 'pin', 'mute', 'favourite', 'archive', 'label', 'lock', 'select', 'delete']);
  assert.equal(chatRowActions({ id: 'p' }, { archived: true }).find((action) => action.id === 'archive').label, 'Unarchive chat');
  assert.deepEqual(chatRowActions({ kind: 'group', id: 'g' }).map((action) => action.id), ['open', 'archive', 'label', 'lock']);
  assert.equal(rowChatKey({ kind: 'group', id: 'g' }), 'group:g');
  assert.equal(rowChatKey({ id: 'p' }), 'p');
  assert.equal(LABEL_PALETTE.length, 20, 'matches the server limit of 20 colours');
  assert.equal(labelColor(99), LABEL_PALETTE[0]);
});

test('invite links: codes are read from links or pasted codes', () => {
  assert.equal(inviteCodeFrom('https://hiddenmessenger.com/join/AbCdEfGhIjKlMnOpQr12'), 'AbCdEfGhIjKlMnOpQr12');
  assert.equal(inviteCodeFrom('  AbCdEfGhIjKlMnOpQr12  '), 'AbCdEfGhIjKlMnOpQr12');
  assert.equal(inviteCodeFrom('https://example.com/other'), null);
  assert.equal(inviteCodeFrom('short'), null);
});

test('new device settings: photo quality, app lock and screen security', () => {
  assert.deepEqual(SECTIONS.security.keys, ['security.appLock', 'security.screenSecurity']);
  assert.deepEqual(SECTIONS.storage.keys, ['media.uploadQuality']);
  assert.equal(validSetting('media.uploadQuality', 'hd'), 'hd');
  assert.equal(validSetting('media.uploadQuality', '4k'), 'standard');
  assert.equal(appLockDelayMs('off'), null);
  assert.equal(appLockDelayMs('immediately'), 0);
  assert.equal(appLockDelayMs('30m'), 30 * 60_000);
  const storage = memoryStorage();
  const settings = createSettings({ storage });
  assert.equal(settings.get('security.appLock'), 'off');
  assert.equal(SETTINGS['security.screenSecurity'].default, false);
});

test('the app wires the parity features into its screens', async () => {
  const [app, chat, groups, list, tools, account, gate, plugin, manifestGradle] = await Promise.all([
    source('src/App.jsx'), source('src/components/ChatWindow.jsx'), source('src/components/GroupsView.jsx'), source('src/components/ChatsList.jsx'),
    source('src/components/ToolsView.jsx'), source('src/components/AccountSettings.jsx'), source('src/components/UsernameGate.jsx'),
    source('android/app/src/main/java/io/github/bickworld555/hiddenchat/HiddenNativePlugin.java'), source('android/app/build.gradle'),
  ]);
  assert.match(app, /connectAccountData\(/);
  assert.match(app, /handleAccountEvent\(event\)/);
  assert.match(app, /event\.type === 'message:edited'/);
  assert.match(app, /<AppLockGate \/>/);
  assert.match(chat, /editDirectMessage\(/);
  assert.match(chat, /<PinnedBanner/);
  assert.match(chat, /<StickerPalette/);
  assert.match(groups, /<MemberAdminActions/);
  assert.match(groups, /<GroupAdminSettings/);
  assert.match(groups, /Only admins can send messages/);
  assert.match(list, /Archived/);
  assert.match(tools, /onCommunities\?\.\(\)/);
  assert.match(account, /<TwoStepSettings/);
  assert.match(gate, /twoStepRequired/);
  for (const method of ['authenticate', 'setSecureScreen', 'saveBytes', 'transcribeAudio', 'securityStatus']) assert.match(plugin, new RegExp(`public void ${method}\\(PluginCall call\\)`));
  assert.match(manifestGradle, /androidx\.biometric:biometric/);
});
