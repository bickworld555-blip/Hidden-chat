// Chat header without the @handle line, WhatsApp-style "last seen" wording, recent chats first when sharing
// (in our "Send to…" sheet and in Android's own share sheet), and a Tools tab without the demo banner.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseShare, parseShareTarget, recentShareTargets } from '../src/shareTarget.js';

const root = new URL('../', import.meta.url);
const source = (path) => readFile(new URL(path, root), 'utf8');

const chats = [
  { id: 'panna', name: 'Panna', lastActivityAt: '2026-11-09T17:11:00Z' },
  { id: 'farzana', username: 'farzana', lastActivityAt: '2026-11-09T11:44:00Z' },
  { id: 'never', name: 'No messages yet', lastActivityAt: null },
  { id: 'me', name: 'Me', lastActivityAt: '2026-11-09T18:00:00Z' },
];
const groups = [{ id: 'dj', name: 'Dj', lastActivityAt: '2026-11-09T12:30:00Z' }];

test('recent chats and groups for one-tap sharing, newest first, never yourself or empty threads', () => {
  const recents = recentShareTargets(chats, groups, 'me');
  assert.deepEqual(recents.map((item) => `${item.kind}:${item.id}`), ['chat:panna', 'group:dj', 'chat:farzana']);
  assert.equal(recentShareTargets(chats, groups, 'me', 2).length, 2);
  assert.deepEqual(recentShareTargets(), []);
});

test('sharing through an Android share-sheet shortcut preselects that chat', () => {
  assert.deepEqual(parseShareTarget('chat:panna'), { kind: 'chat', id: 'panna' });
  assert.deepEqual(parseShareTarget('group:dj'), { kind: 'group', id: 'dj' });
  assert.equal(parseShareTarget(''), null);
  assert.equal(parseShareTarget('other:1'), null);
  assert.deepEqual(parseShare({ text: 'https://fb.watch/x', target: 'chat:panna' }).target, { kind: 'chat', id: 'panna' });
  assert.equal(parseShare({ text: 'https://fb.watch/x' }).target, null);
});

test('Android share sheet shows recent chats (with photos) as Hidden Messenger direct-share targets', async () => {
  const xml = await source('android/app/src/main/res/xml/shortcuts.xml');
  assert.match(xml, /<share-target android:targetClass="io\.github\.bickworld555\.hiddenchat\.MainActivity">[\s\S]*mimeType="text\/plain"[\s\S]*category\.SHARE_TARGET/);
  const manifest = await source('android/app/src/main/AndroidManifest.xml');
  assert.ok(manifest.includes('android:name="android.app.shortcuts" android:resource="@xml/shortcuts"'));
  const shortcuts = await source('android/app/src/main/java/io/github/bickworld555/hiddenchat/ShareShortcuts.java');
  assert.ok(shortcuts.includes('.setLongLived(true)') && shortcuts.includes('.setCategories(categories)') && shortcuts.includes('ShortcutManagerCompat.setDynamicShortcuts'));
  const plugin = await source('android/app/src/main/java/io/github/bickworld555/hiddenchat/HiddenNativePlugin.java');
  assert.match(plugin, /clearSession\(PluginCall call\) \{[\s\S]*?ShareShortcuts\.clear/, 'signing out removes them');
  const shared = await source('android/app/src/main/java/io/github/bickworld555/hiddenchat/SharedContent.java');
  assert.ok(shared.includes('Intent.EXTRA_SHORTCUT_ID'));
  const sheet = await source('src/components/ShareSheet.jsx');
  assert.ok(sheet.includes('className="wa-share-recents"') && sheet.includes('onClick={() => send([item])}'), 'one tap on a recent chat sends to it');
});

test('chat header: name and status only; Tools has no demo banner', async () => {
  const chat = await source('src/components/ChatWindow.jsx');
  assert.ok(!chat.includes('conversation-handle'));
  const tools = await source('src/components/ToolsView.jsx');
  const app = await source('src/App.jsx');
  for (const text of ['Demo mode', 'Hidden Messenger workspace']) {
    assert.ok(!tools.includes(text), `Tools: ${text}`);
    assert.ok(!app.includes(text), `App: ${text}`);
  }
});
