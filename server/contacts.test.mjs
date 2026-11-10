// Contact book vs chat list: direct chats that are not saved contacts, deleting threads, and the row gestures.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import WebSocket from 'ws';
import { createChatServer } from './index.mjs';
import { useChatStore } from '../src/store.js';
import { exactHandleMatch, matchesPerson, mergeSuggestions, savedContacts, splitLinks, unsavedThreads } from '../src/contactBook.js';
import { chatRowActions, deleteChatPrompt, deleteOutcome } from '../src/chatListActions.js';
import { createLongPress } from '../src/longPress.js';

let service;
let directory;
let baseUrl;
let counter = 0;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'relay-contacts-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'contacts.sqlite') });
  const address = await service.listen();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await service?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function register(prefix) {
  counter += 1;
  const response = await fetch(`${baseUrl}/api/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `${prefix}${counter}`, dob: '1990-04-12', password: 'Correct-Horse-Battery-42!' }),
  });
  assert.equal(response.status, 201);
  return response.json();
}

const auth = (session, extra = {}) => ({ Authorization: 'Bearer ' + session.token, ...extra });
const link = (session, userId, save) => fetch(`${baseUrl}/api/v1/contacts`, { method: 'POST', headers: auth(session, { 'Content-Type': 'application/json' }), body: JSON.stringify(save === undefined ? { userId } : { userId, save }) });
const links = async (session) => (await fetch(`${baseUrl}/api/v1/contacts`, { headers: auth(session) })).json();
const deleteChat = (session, peerId) => fetch(`${baseUrl}/api/v1/chats/${peerId}/delete`, { method: 'POST', headers: auth(session, { 'Content-Type': 'application/json' }), body: '{}' });

function connectSocket(session) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:') + '/ws', [`relay.auth.${session.token}`, 'relay.v1']);
  socket.events = [];
  socket.on('message', (raw) => socket.events.push(JSON.parse(raw.toString())));
  return new Promise((resolve, reject) => { socket.once('open', () => resolve(socket)); socket.once('error', reject); });
}

function until(check, label, timeout = 4000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const value = check();
      if (value) return resolve(value);
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${label}`));
      setTimeout(poll, 20);
    })();
  });
}

test('direct chats link people without saving them; Add saves; saving never downgrades', async () => {
  const me = await register('me');
  const pal = await register('pal');
  const friend = await register('friend');

  const direct = await link(me, pal.user.id, false);
  assert.equal(direct.status, 200);
  assert.deepEqual([(await direct.json()).saved, (await links(me)).find((row) => row.id === pal.user.id).saved], [false, false], 'a direct chat is in the list but not the contact book');
  assert.equal((await links(pal)).some((row) => row.id === me.user.id), false, 'the other side is not linked until they talk');

  const added = await (await link(me, friend.user.id)).json();
  assert.equal(added.saved, true, 'the default saves (Add button)');
  assert.equal((await (await link(me, friend.user.id, false)).json()).saved, true, 'a later direct chat does not unsave a contact');
  assert.equal((await (await link(me, pal.user.id, true)).json()).saved, true, 'Add promotes a direct chat to a saved contact');
  assert.equal((await link(me, me.user.id, true)).status, 400);
  assert.equal((await link(me, 'nobody', true)).status, 404);
});

test('a message links both sides as unsaved threads; deleting removes an unsaved thread but keeps a saved contact hidden until the next message', async () => {
  const me = await register('me');
  const stranger = await register('stranger');
  const buddy = await register('buddy');
  await link(me, buddy.user.id, true);
  const mine = await connectSocket(me);
  const theirs = await connectSocket(stranger);

  mine.send(JSON.stringify({ type: 'message:send', message: { id: `m-${counter}-1`, receiverId: stranger.user.id, content: 'hello stranger' } }));
  await until(() => theirs.events.find((event) => event.type === 'message:new'), 'delivery');
  const strangerLink = (await links(stranger)).find((row) => row.id === me.user.id);
  assert.deepEqual([strangerLink.saved, strangerLink.hidden], [false, false], 'the recipient gets an unsaved thread');
  assert.equal((await links(me)).find((row) => row.id === stranger.user.id).saved, false);

  // Deleting the unsaved thread removes the link entirely.
  const dropped = await (await deleteChat(me, stranger.user.id)).json();
  assert.deepEqual(dropped, { hidden: 1, kept: false });
  assert.equal((await links(me)).some((row) => row.id === stranger.user.id), false);
  const deletedEvent = await until(() => mine.events.find((event) => event.type === 'chat:deleted' && event.peerId === stranger.user.id), 'chat:deleted');
  assert.equal(deletedEvent.kept, false);

  // Deleting a saved contact's thread hides it but keeps the contact.
  mine.send(JSON.stringify({ type: 'message:send', message: { id: `m-${counter}-2`, receiverId: buddy.user.id, content: 'hi buddy' } }));
  await until(() => mine.events.find((event) => event.type === 'message:ack' && event.message.id === `m-${counter}-2`), 'ack');
  const kept = await (await deleteChat(me, buddy.user.id)).json();
  assert.deepEqual(kept, { hidden: 1, kept: true });
  const buddyLink = (await links(me)).find((row) => row.id === buddy.user.id);
  assert.deepEqual([buddyLink.saved, buddyLink.hidden], [true, true], 'still a contact, thread hidden');
  assert.equal((await (await fetch(`${baseUrl}/api/v1/messages?peerId=${buddy.user.id}`, { headers: auth(me) })).json()).length, 0, 'history is cleared for me');
  assert.equal((await until(() => mine.events.find((event) => event.type === 'chat:deleted' && event.peerId === buddy.user.id), 'kept event')).kept, true);

  // A new message brings the hidden thread back without changing the saved flag.
  const buddySocket = await connectSocket(buddy);
  buddySocket.send(JSON.stringify({ type: 'message:send', message: { id: `m-${counter}-3`, receiverId: me.user.id, content: 'you there?' } }));
  await until(() => mine.events.find((event) => event.type === 'message:new' && event.message.id === `m-${counter}-3`), 'reply');
  const restored = (await links(me)).find((row) => row.id === buddy.user.id);
  assert.deepEqual([restored.saved, restored.hidden], [true, false]);

  // Opening the chat from the picker also un-hides it.
  await deleteChat(me, buddy.user.id);
  assert.equal((await (await link(me, buddy.user.id, false)).json()).hidden, false);
  assert.equal((await links(me)).find((row) => row.id === buddy.user.id).hidden, false);
  assert.equal((await deleteChat(me, me.user.id)).status, 400);
  mine.close(); theirs.close(); buddySocket.close();
});

test('existing databases migrate: old contact rows become saved, visible threads', () => {
  const path = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE contacts (owner_id TEXT NOT NULL, contact_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(owner_id, contact_id), CHECK(owner_id <> contact_id));
    INSERT INTO contacts VALUES ('a', 'b', 1), ('b', 'a', 1)`);
  legacy.close();
  const migrated = createChatServer({ port: 0, host: '127.0.0.1', databasePath: path });
  try {
    assert.deepEqual(migrated.db.prepare("SELECT owner_id, saved, hidden FROM contacts WHERE owner_id IN ('a', 'b') ORDER BY owner_id").all().map((row) => [row.owner_id, row.saved, row.hidden]), [['a', 1, 0], ['b', 1, 0]]);
  } finally {
    migrated.db.close();
  }
});

test('the store keeps saved-but-hidden contacts for the picker and restores them on the next message', () => {
  const initial = useChatStore.getState();
  try {
    useChatStore.setState({ userId: '', chats: [], hiddenContacts: [], messages: {}, presence: {}, activeChatId: null, pinnedChatIds: [], mutedChatIds: [], favouriteChatIds: [] });
    const store = useChatStore.getState();
    store.setContacts([
      { id: 'sam', name: 'Sam', username: 'sam', saved: true, hidden: false },
      { id: 'dee', name: 'Dee', username: 'dee', saved: false, hidden: false },
      { id: 'old', name: 'Old Pal', username: 'old', saved: true, hidden: true },
      { id: 'gone', name: 'Gone', username: 'gone', saved: false, hidden: true },
    ]);
    assert.deepEqual(useChatStore.getState().chats.map((chat) => chat.id).sort(), ['dee', 'sam'], 'hidden threads are not in the chat list');
    assert.deepEqual(useChatStore.getState().hiddenContacts.map((chat) => chat.id), ['old'], 'only saved hidden contacts are kept for the picker');
    assert.ok(useChatStore.getState().chats.every((chat) => !('hidden' in chat)), 'the hidden flag does not leak into chat rows');

    store.deleteChat('sam');
    assert.deepEqual(useChatStore.getState().hiddenContacts.map((chat) => chat.id).sort(), ['old', 'sam'], 'deleting a saved contact keeps them in the book');
    store.deleteChat('dee');
    assert.equal(useChatStore.getState().hiddenContacts.some((chat) => chat.id === 'dee'), false, 'an unsaved thread is simply gone');

    store.addMessage({ id: 'x1', senderId: 'sam', receiverId: 'me', senderName: 'Sam', senderUsername: 'sam', content: 'back', timestamp: new Date().toISOString(), status: 'delivered' });
    const sam = useChatStore.getState().chats.find((chat) => chat.id === 'sam');
    assert.equal(sam?.saved, true, 'a message restores the thread, still saved');
    assert.equal(useChatStore.getState().hiddenContacts.some((chat) => chat.id === 'sam'), false);

    store.addContact({ id: 'old', name: 'Old Pal', username: 'old', saved: true, hidden: false });
    assert.equal(useChatStore.getState().hiddenContacts.length, 0, 'opening a hidden contact from the picker restores it');
    store.addContact({ id: 'new', name: 'New', username: 'new', saved: false });
    store.addContact({ id: 'new', name: 'New', username: 'new', saved: true });
    assert.equal(useChatStore.getState().chats.find((chat) => chat.id === 'new').saved, true, 'Add promotes an existing direct chat');

    const picker = savedContacts(useChatStore.getState().chats, useChatStore.getState().hiddenContacts, { userId: '' });
    assert.deepEqual(picker.map((chat) => chat.id), ['new', 'old', 'sam']);
    assert.deepEqual(unsavedThreads(useChatStore.getState().chats, { userId: '' }).map((chat) => chat.id), []);
  } finally {
    useChatStore.setState(initial, true);
  }
});

test('contact-book helpers: split, suggestions and exact handle matching', () => {
  const { chats, hiddenContacts } = splitLinks([{ id: 'a', saved: true, hidden: true }, { id: 'b', saved: false, hidden: false }, { id: 'c', saved: false, hidden: true }, null, { saved: true }]);
  assert.deepEqual([chats.map((c) => c.id), hiddenContacts.map((c) => c.id)], [['b'], ['a']]);
  assert.deepEqual(savedContacts([{ id: 'z', name: 'Zed', saved: true }, { id: 'me', name: 'Me', saved: true }, { id: 'g', name: 'Grp', saved: true, group: true }], [{ id: 'a', name: 'Al', saved: true }, { id: 'z', name: 'Zed', saved: true }], { userId: 'me' }).map((c) => c.id), ['a', 'z'], 'de-duplicated, without self or groups, sorted by name');
  assert.ok(matchesPerson({ name: 'Alice Wonder', username: 'alice' }, '@ALI') && matchesPerson({ name: 'Alice Wonder', username: 'alice' }, 'wonder') && !matchesPerson({ name: 'Bob', username: 'bob' }, 'alice'));
  const known = [{ id: 'k1', name: 'Kim', username: 'kim', saved: true }, { id: 'k2', name: 'Kai', username: 'kai' }];
  const remote = [{ id: 'k1', name: 'Kim', username: 'kim' }, { id: 'r1', name: 'Kira', username: 'kira' }];
  assert.deepEqual(mergeSuggestions(known, remote, 'k').map((p) => [p.id, p.known]), [['k1', true], ['k2', true], ['r1', false]], 'known people first, no duplicates');
  assert.deepEqual(mergeSuggestions(known, remote, '   '), []);
  assert.equal(exactHandleMatch(mergeSuggestions(known, remote, 'kir'), '@Kira')?.id, 'r1');
  assert.equal(exactHandleMatch(mergeSuggestions(known, remote, 'ki'), 'k'), null);
});

test('row actions and delete wording follow the saved/unsaved distinction', () => {
  assert.deepEqual(chatRowActions({ id: 'x' }, { pinned: true, muted: false, favourite: true }).map((a) => a.label), ['Open chat', 'Unpin chat', 'Mute notifications', 'Remove from favourites', 'Archive chat', 'Label chat', 'Lock chat', 'Select chats', 'Delete chat']);
  assert.equal(chatRowActions({ id: 'x' }).find((a) => a.id === 'delete').danger, true);
  assert.match(deleteChatPrompt({ name: 'Sam', saved: true }).body, /stays in your contacts/);
  assert.match(deleteChatPrompt({ name: 'Dee', saved: false }).body, /not in your contacts/);
  assert.equal(deleteChatPrompt([{ name: 'a' }, { name: 'b' }]).confirm, 'Delete 2 chats');
  assert.equal(deleteOutcome([{ status: 'fulfilled' }]), '');
  assert.match(deleteOutcome([{ status: 'rejected' }]), /Could not delete the chat/);
  assert.match(deleteOutcome([{ status: 'rejected' }, { status: 'fulfilled' }]), /^1 chat could not/);
});

test('long press fires after the delay, is cancelled by movement or release, and right-click reports once', () => {
  const timers = new Map();
  let nextId = 1;
  const setTimer = (fn) => { const id = nextId++; timers.set(id, fn); return id; };
  const clearTimer = (id) => timers.delete(id);
  const fire = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  let fired = 0;
  const press = createLongPress(() => { fired += 1; }, { setTimer, clearTimer, slop: 10 });

  press.onPointerDown({ pointerId: 1, clientX: 0, clientY: 0, button: 0 });
  press.onPointerMove({ pointerId: 1, clientX: 4, clientY: 4 });
  fire();
  assert.equal(fired, 1, 'small jitter does not cancel');
  assert.equal(press.consumeFired(), true, 'the follow-up click is swallowed once');
  assert.equal(press.consumeFired(), false);

  press.onPointerDown({ pointerId: 2, clientX: 0, clientY: 0, button: 0 });
  press.onPointerMove({ pointerId: 2, clientX: 0, clientY: 30 });
  fire();
  assert.equal(fired, 1, 'scrolling cancels the press');

  press.onPointerDown({ pointerId: 3, clientX: 0, clientY: 0, button: 0 });
  press.onPointerUp({ pointerId: 3 });
  fire();
  assert.equal(fired, 1, 'lifting early cancels');
  assert.equal(press.consumeFired(), false, 'a plain tap is not swallowed');

  press.onPointerDown({ pointerId: 4, clientX: 0, clientY: 0, button: 2 });
  fire();
  assert.equal(fired, 1, 'secondary buttons do not start a press');
  let prevented = 0;
  press.onContextMenu({ preventDefault: () => { prevented += 1; } });
  assert.deepEqual([fired, prevented], [2, 1], 'right-click opens the actions');
  assert.equal(press.consumeFired(), true);

  press.onPointerDown({ pointerId: 5, clientX: 0, clientY: 0, button: 0 });
  fire();
  press.onContextMenu({ preventDefault: () => { prevented += 1; } });
  assert.deepEqual([fired, prevented], [3, 2], 'a touch long-press followed by contextmenu reports once');
  assert.equal(timers.size, 0, 'no timers leak');
});

test('the UI wires the @username box with live suggestions, direct chats, and long-press chat deletion', async () => {
  const read = async (path) => (await readFile(new URL(path, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const picker = await read('../src/components/SelectContactModal.jsx');
  const list = await read('../src/components/ChatsList.jsx');
  const sidebar = await read('../src/components/Sidebar.jsx');
  const app = await read('../src/App.jsx');
  const drawer = await read('../src/components/ContactInfoDrawer.jsx');
  const styles = await read('../src/styles.css');

  assert.ok(picker.includes('placeholder="Enter @username to add..."') && picker.includes("{adding ? 'Adding...' : 'Add'}"), 'the add box and button are present');
  assert.ok(picker.includes('usePeopleSearch(newHandle, sessionToken)') && picker.includes('className="wa-sc-suggestions"') && picker.includes('mergeSuggestions('), 'typing shows live suggestions');
  assert.ok(picker.includes("openWith(person, { save: false })") && picker.includes("openWith(person, { save: true })") && picker.includes('exactHandleMatch('), 'Chat is a direct thread, Add saves, the Add button resolves the exact handle');
  assert.ok(picker.includes('Recent chats · not in contacts') && picker.includes('savedContacts(rawChats, hiddenContacts'), 'saved contacts and recent direct chats are listed separately');
  assert.ok(list.includes("linkContact(sessionToken, contact.id, { save: false })") && sidebar.includes("linkContact(sessionToken, contact.id, { save: false })") && app.includes("linkContact(sessionToken, resolvedId, { save: false })"), 'home search, sidebar search and calls never save a contact');

  assert.ok(list.includes('createLongPress(') && list.includes('{...rowPressHandlers(chat)}') && list.includes('longPress.consumeFired()'), 'rows use the pointer-based long press');
  assert.ok(!list.includes('onTouchStart') && !list.includes('window.confirm') && !list.includes('window.alert'), 'no duplicate touch/mouse handlers or native dialogs');
  assert.ok(list.includes('className="wa-action-sheet"') && list.includes("role=\"alertdialog\"") && list.includes('deleteChatPrompt(pendingDelete)') && list.includes("deleteChat(targets[index].id, { kept: result.value?.kept })"), 'an action sheet with a confirm dialog deletes the thread');
  assert.ok(drawer.includes("store().deleteChat(chatId, { kept })") && app.includes("deleteChat(event.peerId, { kept: event.kept })"), 'every delete path keeps saved contacts');
  assert.ok(styles.includes('.wa-action-sheet {') && styles.includes('.wa-row-wrapper { touch-action: pan-y;'), 'sheet styling and a scroll-friendly press surface');
});
