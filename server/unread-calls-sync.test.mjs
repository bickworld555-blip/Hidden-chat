// Unread badges clear when a chat is seen (also when it was seen before the connection was up), the Calls tab badge
// counts missed calls since the tab was last opened, and native decline / hang-up reach the server at once.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { useChatStore } from '../src/store.js';
import { unseenMissedCalls } from '../src/notificationSettings.js';

const root = new URL('../', import.meta.url);
const java = (name) => readFile(new URL(`android/app/src/main/java/io/github/bickworld555/hiddenchat/${name}`, root), 'utf8');

function seedChat(status = 'delivered') {
  const message = { id: 'm1', senderId: 'ava', receiverId: 'me', timestamp: '2026-11-12T04:00:00Z', content: 'hi', status };
  useChatStore.setState({ userId: 'me', client: null, chats: [{ id: 'ava', unread: 1 }], messages: { ava: [message] } });
}

test('a chat seen on screen clears its badge and sends its read receipt', () => {
  seedChat();
  const sent = [];
  useChatStore.getState().setClient({ send: (event) => sent.push(event) });
  useChatStore.getState().readChat('ava');
  assert.equal(useChatStore.getState().chats[0].unread, 0);
  assert.deepEqual(sent, [{ type: 'message:read', messageId: 'm1' }]);
  assert.equal(useChatStore.getState().messages.ava[0].status, 'read');
  useChatStore.getState().readChat('ava');
  assert.equal(sent.length, 1, 'no second receipt once it is read');
});

test('a chat seen before the connection was up sends its receipts as soon as it connects', () => {
  seedChat();
  useChatStore.getState().readChat('ava');
  assert.equal(useChatStore.getState().chats[0].unread, 0, 'the badge clears at once');
  const sent = [];
  useChatStore.getState().setClient({ send: (event) => sent.push(event) });
  assert.deepEqual(sent, [{ type: 'message:read', messageId: 'm1' }], 'so the server does not bring the badge back');
});

test('the Calls badge counts missed calls since the tab was last opened, then starts again from 1', () => {
  const logs = [
    { status: 'missed', timestamp: '2026-11-12T04:10:00Z' },
    { status: 'missed', timestamp: '2026-11-12T04:12:00Z' },
    { status: 'completed', timestamp: '2026-11-12T04:13:00Z' },
  ];
  assert.equal(unseenMissedCalls(logs, 0), 2);
  const opened = Date.parse('2026-11-12T04:12:30Z');
  assert.equal(unseenMissedCalls(logs, opened), 0);
  assert.equal(unseenMissedCalls([...logs, { status: 'missed', timestamp: '2026-11-12T04:20:00Z' }], opened), 1);
});

test('Android decline and hang-up end the call on the server at once', async () => {
  const receiver = await java('CallActionReceiver.java');
  assert.match(receiver, /static void hangUp\(Context context\) \{[\s\S]*?endOnServer\(app, activeCallId, "hang-up"\);/);
  assert.match(receiver, /static void decline\(Context context, String callId\) \{[\s\S]*?endOnServer\(context\.getApplicationContext\(\), callId, "decline"\);[\s\S]*?NativeRelay\.declinePendingCall/,
    'the server first, then the connection or the app');
  const plugin = await java('HiddenNativePlugin.java');
  assert.ok(plugin.includes('CallActionReceiver.activeCallId = active ? call.getString("callId") : null;'));
});
