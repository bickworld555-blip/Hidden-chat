import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  NOTIFICATION_CHANNELS, channelForCategory, classifyIncoming, conversationOpenParam, groupNotificationText,
  parseConversationOpenParam, shouldAlertGroup,
} from '../src/notificationChannels.js';
import { DEFAULT_GROUP_TONE, DEFAULT_NOTIFICATION_TONE, defaultToneForCategory, resolveToneChoice } from '../src/tones.js';

test('direct and group messages are classified into separate channels', () => {
  const direct = classifyIncoming({ type: 'message:new', message: { senderId: 'ava', content: 'hi' } }, 'me');
  assert.equal(direct.isGroup, false);
  assert.equal(direct.channel.id, 'direct_messages');
  assert.equal(direct.channel.name, 'Direct Messages');
  assert.deepEqual(direct.conversation, { kind: 'chat', id: 'ava' });
  const group = classifyIncoming({ type: 'group:message', message: { groupId: 'g1', senderId: 'ava', content: 'hi' } }, 'me');
  assert.equal(group.isGroup, true);
  assert.equal(group.channel.id, 'group_messages');
  assert.equal(group.channel.name, 'Group Messages');
  assert.deepEqual(group.conversation, { kind: 'group', id: 'g1' });
  assert.equal(classifyIncoming({ type: 'group:message', message: { groupId: 'g1', senderId: 'me' } }, 'me'), null, 'own messages never alert');
  assert.equal(classifyIncoming({ type: 'message:ack', message: { senderId: 'ava' } }, 'me'), null);
  assert.equal(channelForCategory('group'), NOTIFICATION_CHANNELS.group_messages);
  assert.equal(channelForCategory('message'), NOTIFICATION_CHANNELS.direct_messages);
  assert.equal(channelForCategory('reaction'), NOTIFICATION_CHANNELS.reactions);
});

test('group messages default to a different tone than direct messages', () => {
  assert.notEqual(DEFAULT_GROUP_TONE, DEFAULT_NOTIFICATION_TONE);
  assert.equal(resolveToneChoice('default', 'notification', [], defaultToneForCategory('group', 'notification')).tone.id, DEFAULT_GROUP_TONE);
  assert.equal(resolveToneChoice('default', 'notification', [], defaultToneForCategory('message', 'notification')).tone.id, DEFAULT_NOTIFICATION_TONE);
  assert.equal(resolveToneChoice('ping', 'notification', [], DEFAULT_GROUP_TONE).tone.id, 'ping', 'an explicit choice still wins');
  assert.equal(resolveToneChoice('silent', 'notification', [], DEFAULT_GROUP_TONE).kind, 'silent');
});

test('group alerts read like a lock-screen entry and respect mute and the open conversation', () => {
  assert.deepEqual(groupNotificationText({ groupName: 'Family', senderName: 'Ava', message: { content: 'Dinner at 8' } }), { title: 'Family', body: 'Ava: Dinner at 8' });
  assert.deepEqual(groupNotificationText({ message: { content: 'hi' } }), { title: 'New group message', body: 'hi' });
  assert.equal(shouldAlertGroup({ groupId: 'g1', mutedGroupIds: ['g1'] }), false);
  assert.equal(shouldAlertGroup({ groupId: 'g1', viewingGroupId: 'g1', pageVisible: true }), false);
  assert.equal(shouldAlertGroup({ groupId: 'g1', viewingGroupId: 'g1', pageVisible: false }), true, 'a hidden tab still alerts');
  assert.equal(shouldAlertGroup({ groupId: 'g1', viewingGroupId: 'g2', pageVisible: true }), true);
});

test('notification clicks round-trip the conversation to open', () => {
  assert.equal(conversationOpenParam({ kind: 'group', id: 'g1' }), 'group:g1');
  assert.deepEqual(parseConversationOpenParam('group:g1'), { kind: 'group', id: 'g1' });
  assert.deepEqual(parseConversationOpenParam('chat:abc-123'), { kind: 'chat', id: 'abc-123' });
  assert.equal(parseConversationOpenParam('javascript:alert(1)'), null);
  assert.equal(parseConversationOpenParam(''), null);
});
