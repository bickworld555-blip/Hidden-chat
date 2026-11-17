// Unknown sender (src/components/UnknownSender.jsx): someone not in my contacts who wrote gets the WhatsApp-style card
// at the top of the chat (Add, Block, Safety tools); saved, named, blocked, group or own chats never do.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const { isUnknownSender, dismissUnknown, readDismissed } = await import('../src/unknownSender.js');

test('the card shows only for an unsaved person who wrote to me', () => {
  const wrote = [{ senderId: 'x' }];
  assert.equal(isUnknownSender({ chat: { id: 'x', saved: false }, messages: wrote, userId: 'me' }), true);
  assert.equal(isUnknownSender({ chat: { id: 'x', saved: false }, messages: [{ senderId: 'me' }], userId: 'me' }), false, 'I wrote first: not a stranger writing to me');
  assert.equal(isUnknownSender({ chat: { id: 'x', saved: true }, messages: wrote }), false, 'saved');
  assert.equal(isUnknownSender({ chat: { id: 'x', alias: 'Rana' }, messages: wrote }), false, 'named by me (or my phonebook)');
  assert.equal(isUnknownSender({ chat: { id: 'x' }, messages: wrote, blocked: true }), false, 'blocked');
  assert.equal(isUnknownSender({ chat: { id: 'g', group: true }, messages: [{ senderId: 'g' }] }), false, 'groups');
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  dismissUnknown('x', storage);
  assert.ok(readDismissed(storage).has('x'), 'hidden per chat, remembered');
});

test('the chat wires Add (name sheet), Block (the block dialog) and Safety tools (block and report)', () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const chat = read('src/components/ChatWindow.jsx');
  assert.match(chat, /isUnknownSender\(\{ chat, messages, blocked, userId \}\) && \(isMessageRequest\(chat\) \|\| !unknownHidden\.has\(chatId\)\)/, 'a message request cannot be hidden, only handled');
  assert.match(chat, /onAdd=\{\(\) => setNamingUnknown\(true\)\}/);
  assert.match(chat, /onBlock=\{\(\) => openInfo\('main', 'block'\)\}/);
  assert.match(chat, /onReport=\{\(\) => \{ setSafetyOpen\(false\); openInfo\('main', 'report'\); \}\}/);
  const sheet = read('src/components/UnknownSender.jsx');
  assert.ok(sheet.includes('Block contact') && sheet.includes('Report contact') && sheet.includes('not checked by Hidden Messenger'));
  assert.ok(sheet.includes('(no messages are sent)'), 'says truthfully what a report sends (server/admin.mjs: the reason only)');
  const drawer = read('src/components/ContactInfoDrawer.jsx');
  assert.match(drawer, /\{!chat\.saved && !chat\.alias && <Row icon=\{ShieldAlert\} title="Safety tools"/);
});
