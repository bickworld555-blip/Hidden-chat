// Group lifecycle controls over XMPP (src/e2e/lifecycle.js, src/e2e/messaging.js sendGroupControlFor): delete, edit,
// react and played for group messages that travelled over XMPP, sealed with the group's Sender Keys and sent through
// the group <fanout>. The rules match the server's group endpoints: delete by the author within 24 h or by an admin,
// edit by the author within 15 minutes, react by any member, played by anyone but the author.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOCK_SKEW_MS, DELETE_WINDOW_MS, EDIT_WINDOW_MS, controlContent, createControlBuffer, parseControl, resolveControl, roleIn,
} from '../src/e2e/lifecycle.js';
import { sendGroupControlFor } from '../src/e2e/messaging.js';

const GROUP = 'g-1';
const T0 = Date.parse('2026-11-15T04:00:00Z');
const AUTHOR = 'author';
const ADMIN = 'admin';
const MEMBER = 'member';
const details = { members: [{ id: AUTHOR, role: 'member' }, { id: ADMIN, role: 'admin' }, { id: MEMBER, role: 'member' }] };
const roleOf = (userId) => roleIn(details, userId);
const post = { id: 'gm1', groupId: GROUP, senderId: AUTHOR, content: 'hello group', createdAt: T0, via: 'xmpp' };
const voice = { id: 'gm2', groupId: GROUP, senderId: AUTHOR, content: 'voice:media-1:7', createdAt: T0, via: 'xmpp' };
const groupControl = (op, extra = {}) => parseControl(controlContent({ op, target: extra.target ?? 'gm1', groupId: extra.groupId ?? GROUP, at: extra.at ?? T0 + 1000, ...extra }));
const resolve = (control, senderId, target = post, extra = {}) => resolveControl(control, { senderId, target, me: MEMBER, groupId: GROUP, roleOf, ...extra });

test('a group control names its group, never a person too; anything malformed is refused', () => {
  const sealed = controlContent({ op: 'delete', target: 'gm1', groupId: GROUP, at: T0 });
  assert.deepEqual(JSON.parse(sealed.slice(4)), { op: 'delete', t: 'gm1', g: GROUP, at: T0 });
  assert.deepEqual(parseControl(sealed), { op: 'delete', target: 'gm1', at: T0, groupId: GROUP });
  assert.throws(() => controlContent({ op: 'delete', target: 'gm1', groupId: GROUP, peerId: 'p' }), /either a person or a group/);
  assert.throws(() => controlContent({ op: 'delete', target: 'gm1' }), /either a person or a group/);
  for (const bad of [{ op: 'delete', t: 'gm1', g: GROUP, p: 'p', at: T0 }, { op: 'delete', t: 'gm1', at: T0 }, { op: 'delete', t: 'gm1', g: 'bad group!', at: T0 }]) {
    assert.equal(parseControl(`ctl:${JSON.stringify(bad)}`), null, JSON.stringify(bad));
  }
});

test('roles come from the device’s copy of the group details', () => {
  assert.equal(roleIn(details, ADMIN), 'admin');
  assert.equal(roleIn(details, MEMBER), 'member');
  assert.equal(roleIn(details, 'stranger'), null);
  assert.equal(roleIn(null, ADMIN), null, 'no details kept: nobody is taken for an admin');
});

test('group delete: the author within 24 hours, or an admin at any time; nobody else', () => {
  assert.deepEqual(resolve(groupControl('delete'), AUTHOR), { action: 'apply', event: { type: 'group:message-deleted', groupId: GROUP, messageId: 'gm1', reason: 'deleted', by: AUTHOR } });
  assert.equal(resolve(groupControl('delete'), MEMBER).reason, 'not-sender');
  const late = T0 + DELETE_WINDOW_MS + CLOCK_SKEW_MS + 1;
  assert.equal(resolve(groupControl('delete', { at: late }), AUTHOR).reason, 'too-late');
  assert.equal(resolve(groupControl('delete', { at: late }), ADMIN).action, 'apply', 'an admin may delete anyone’s message, any time');
  assert.equal(resolve(groupControl('delete'), ADMIN, post, { roleOf: () => null }).reason, 'not-sender', 'without group details an admin is not assumed');
});

test('group edit: only the author, only text, within 15 minutes; an older edit never replaces a newer one', () => {
  const edit = (extra) => groupControl('edit', { text: 'fixed', ...extra });
  const applied = resolve(edit(), AUTHOR);
  assert.equal(applied.event.type, 'group:message-edited');
  assert.deepEqual([applied.event.content, applied.event.senderId], ['fixed', AUTHOR]);
  assert.equal(resolve(edit(), ADMIN).reason, 'not-sender', 'admins delete, they do not edit others’ words');
  assert.equal(resolve(edit({ at: T0 + EDIT_WINDOW_MS + CLOCK_SKEW_MS + 1 }), AUTHOR).reason, 'too-late');
  assert.equal(resolve(edit({ target: 'gm2' }), AUTHOR, voice).reason, 'not-text');
  assert.equal(resolve(edit(), AUTHOR, { ...post, editedAt: new Date(T0 + 5000).toISOString() }).reason, 'older');
  assert.equal(resolve(edit(), AUTHOR, { ...post, deleted: true }).reason, 'deleted');
});

test('group react: any member, the latest per member wins; not on a deleted message', () => {
  const react = (emoji, at) => groupControl('react', { emoji, at });
  const applied = resolve(react('👍', T0 + 10), MEMBER);
  assert.deepEqual(applied.event, { type: 'group:message-reaction', groupId: GROUP, messageId: 'gm1', userId: MEMBER, emoji: '👍', at: T0 + 10, messageSenderId: AUTHOR });
  assert.equal(resolve(react('🎉', T0 + 5), MEMBER, post, { reactedAt: () => T0 + 10 }).reason, 'older');
  assert.equal(resolve(react(null, T0 + 20), MEMBER, post, { reactedAt: () => T0 + 10 }).event.emoji, null, 'a newer removal wins');
  assert.equal(resolve(react('👍', T0 + 10), AUTHOR).action, 'apply', 'the author may react too');
  assert.equal(resolve(react('👍', T0 + 10), MEMBER, { ...post, deleted: true }).reason, 'deleted');
});

test('group played: anyone but the author', () => {
  assert.deepEqual(resolve(groupControl('played', { target: 'gm2' }), MEMBER, voice).event, { type: 'group:message-played', groupId: GROUP, messageId: 'gm2', userId: MEMBER });
  assert.equal(resolve(groupControl('played', { target: 'gm2' }), AUTHOR, voice).reason, 'not-listener');
});

test('a group control acts only in its own group, waits for a message not here yet, and never crosses into a direct chat', () => {
  assert.equal(resolve(groupControl('delete', { groupId: 'g-2' }), AUTHOR).reason, 'not-this-chat', 'names another group');
  assert.equal(resolve(groupControl('delete'), AUTHOR, { ...post, groupId: 'g-2' }).reason, 'not-this-chat', 'the message is in another group');
  assert.equal(resolve(groupControl('delete'), AUTHOR, null).action, 'hold');
  assert.equal(resolveControl(groupControl('delete'), { senderId: AUTHOR, target: post, me: MEMBER }).reason, 'not-this-chat', 'a group control opened as a direct message does nothing');
  const direct = parseControl(controlContent({ op: 'delete', target: 'gm1', peerId: MEMBER, at: T0 + 1000 }));
  assert.equal(resolve(direct, AUTHOR).reason, 'not-this-chat', 'a direct control opened with group keys does nothing');
  const buffer = createControlBuffer({ now: () => T0 });
  buffer.hold(groupControl('delete'), AUTHOR);
  const [waiting] = buffer.take('gm1');
  assert.equal(waiting.control.groupId, GROUP, 'held with its group until the message arrives, like direct controls');
  assert.equal(resolve(waiting.control, waiting.senderId).action, 'apply');
});

test('sendGroupControlFor: sealed with the group keys and sent through the fanout; otherwise the server path', async () => {
  const sent = [];
  const sealed = [];
  const session = { sendGroup: async (args) => { sent.push(args); return { id: args.messageId }; } };
  const seal = async (groupId, content, send) => { sealed.push({ groupId, content }); return send(`e2e2:text|${JSON.stringify({ v: 2, sd: 'phone', mh: 'h', g: {} })}`); };
  assert.equal(await sendGroupControlFor(post, { op: 'delete' }, { session, seal }), true);
  assert.equal(sealed[0].groupId, GROUP);
  assert.deepEqual({ ...parseControl(sealed[0].content), at: 0 }, { op: 'delete', target: 'gm1', at: 0, groupId: GROUP });
  assert.equal(sent[0].groupId, GROUP);
  assert.ok(sent[0].envelope.startsWith('e2e2:') && sent[0].messageId, 'one sealed envelope through the group fanout');

  assert.equal(await sendGroupControlFor({ ...post, via: undefined }, { op: 'delete' }, { session, seal }), false, 'a message the server stored keeps its endpoint');
  assert.equal(await sendGroupControlFor(post, { op: 'delete' }, { session: null, seal }), false, 'no XMPP session');
  assert.equal(await sendGroupControlFor({ ...post, groupId: undefined }, { op: 'delete' }, { session, seal }), false);
  assert.equal(sealed.length, 1, 'nothing sealed for those');

  let confirmed = false;
  const offSession = { sendGroup: async () => null };
  const confirmingSeal = async (groupId, content, send) => { await send('e2e2:x'); confirmed = true; };
  assert.equal(await sendGroupControlFor(post, { op: 'edit', text: 'x' }, { session: offSession, seal: confirmingSeal }), false, 'groups over XMPP off: the server path');
  assert.equal(confirmed, false, 'the Sender Key is not confirmed for a control that never left');
  const missingKeys = async () => { throw Object.assign(new Error('keys'), { code: 'group-keys-missing' }); };
  assert.equal(await sendGroupControlFor(post, { op: 'react', emoji: '👍' }, { session, seal: missingKeys }), false);
});

test('group changes apply to this device’s copy whichever way they come: a server delete no longer leaves the words behind', async () => {
  const { useChatStore } = await import('../src/store.js');
  const { applyGroupChange } = await import('../src/groupChanges.js');
  const store = useChatStore.getState();
  store.mergeGroupMessages('g-store', [
    { id: 's1', groupId: 'g-store', senderId: AUTHOR, content: 'secret plans', createdAt: T0 },
    { id: 's2', groupId: 'g-store', senderId: AUTHOR, content: 'typo', createdAt: T0 + 1 },
    { id: 's3', groupId: 'g-store', senderId: AUTHOR, content: 'voice:media-9:4', createdAt: T0 + 2 },
  ]);
  // The server's own event (a message it stored, deleted by its author or an admin).
  assert.equal(applyGroupChange(useChatStore.getState(), { type: 'group:message-deleted', groupId: 'g-store', messageId: 's1', reason: 'deleted' }), true);
  const deleted = useChatStore.getState().groupMessage('g-store', 's1');
  assert.deepEqual([deleted.deleted, deleted.content, deleted.senderId], [true, '', AUTHOR], 'a placeholder: sender and time, nothing of what it said');
  // A control's edit carries open words; the server's carries sealed words, which the history refresh opens.
  applyGroupChange(useChatStore.getState(), { type: 'group:message-edited', groupId: 'g-store', messageId: 's2', content: 'fixed', editedAt: new Date(T0 + 60_000).toISOString() });
  assert.equal(useChatStore.getState().groupMessage('g-store', 's2').content, 'fixed');
  assert.equal(applyGroupChange(useChatStore.getState(), { type: 'group:message-edited', groupId: 'g-store', messageId: 's2', content: 'e2e2:text|{}' }), false);
  assert.equal(useChatStore.getState().groupMessage('g-store', 's2').content, 'fixed', 'sealed words are never shown as text');
  applyGroupChange(useChatStore.getState(), { type: 'group:message-edited', groupId: 'g-store', messageId: 's1', content: 'back from the dead' });
  assert.equal(useChatStore.getState().groupMessage('g-store', 's1').content, '', 'a deleted message is never edited back');
  // Reactions per member, the latest wins (the rules decided that before); removal clears it.
  applyGroupChange(useChatStore.getState(), { type: 'group:message-reaction', groupId: 'g-store', messageId: 's2', userId: MEMBER, emoji: '👍' });
  applyGroupChange(useChatStore.getState(), { type: 'group:message-reaction', groupId: 'g-store', messageId: 's2', userId: ADMIN, emoji: '🎉' });
  applyGroupChange(useChatStore.getState(), { type: 'group:message-reaction', groupId: 'g-store', messageId: 's2', userId: ADMIN, emoji: null });
  assert.deepEqual(useChatStore.getState().groupMessage('g-store', 's2').reactions, { [MEMBER]: '👍' });
  applyGroupChange(useChatStore.getState(), { type: 'group:message-played', groupId: 'g-store', messageId: 's3', userId: MEMBER });
  assert.deepEqual(useChatStore.getState().groupMessage('g-store', 's3').playedBy, [MEMBER]);
  assert.equal(applyGroupChange(useChatStore.getState(), { type: 'group:message-deleted', groupId: 'g-store', messageId: 'missing' }), false);
});

test('groups over XMPP follow the server’s per-user rollout; a caller may still decide', async () => {
  const { startXmppSession } = await import('../src/xmpp/session.js');
  const envelope = `e2e2:text|${JSON.stringify({ v: 2, sd: 'phone', mh: 'h', g: {} })}`;
  const start = (decision, extra = {}) => startXmppSession({
    sessionToken: 't', userId: AUTHOR, deliver: () => {}, legacySend: () => {}, targetsFor: async () => ({ targets: [], complete: false }),
    groupTargetsFor: async () => ({ targets: ['d1@h'], complete: true, sender: { userId: AUTHOR, deviceId: 'phone' } }),
    fetchImpl: async () => new Response(JSON.stringify(decision), { status: 200 }),
    createTransport: () => ({ state: 'online', sendSealed() {}, setActive() {}, close() {}, checkNow() {} }), ...extra,
  });
  const on = await start({ transport: 'xmpp', groups: true });
  assert.equal((await on.sendGroup({ groupId: GROUP, messageId: 'x1', envelope })).via, 'xmpp');
  const off = await start({ transport: 'xmpp', groups: false });
  assert.equal(await off.sendGroup({ groupId: GROUP, messageId: 'x2', envelope }), null, 'the server says not yet: the server path');
  const old = await start({ transport: 'xmpp' });
  assert.equal(await old.sendGroup({ groupId: GROUP, messageId: 'x3', envelope }), null, 'a server that does not say: off');
  const forced = await start({ transport: 'xmpp', groups: true }, { groupsOverXmpp: false });
  assert.equal(await forced.sendGroup({ groupId: GROUP, messageId: 'x4', envelope }), null);
});
