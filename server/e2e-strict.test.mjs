// Strict end-to-end encryption: nothing people write is sent readable. Direct messages to a contact without keys
// wait ("waiting"), group messages wait in groupPending.js, and both go out sealed once everyone has keys.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { mergeMessageStatus } from '../src/messageStatus.js';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

test('"waiting" replaces an optimistic sent or failed, and gives way once the message really goes out', () => {
  assert.equal(mergeMessageStatus('sent', 'waiting'), 'waiting');
  assert.equal(mergeMessageStatus('failed', 'waiting'), 'waiting');
  assert.equal(mergeMessageStatus('delivered', 'waiting'), 'delivered', 'a delivered message never goes back');
  assert.equal(mergeMessageStatus('waiting', 'sent'), 'sent');
  assert.equal(mergeMessageStatus('waiting', 'delivered'), 'delivered');
  assert.equal(mergeMessageStatus('read', 'sent'), 'read', 'the usual order still holds');
});

test('no code path sends people’s messages readable', async () => {
  const [client, messaging, groups, pending] = await Promise.all([read('../src/e2e/client.js'), read('../src/e2e/messaging.js'), read('../src/components/GroupsView.jsx'), read('../src/groupPending.js')]);
  assert.match(client, /if \(!peer\.length\) throw new PeerKeysMissing\(peerId\);/, 'a contact without keys stops the send');
  assert.doesNotMatch(client, /if \(!peer\.length\) return content;/);
  assert.match(client, /if \(!session\) throw new GroupKeysMissing\(\[\]\);/);
  assert.match(client, /if \(!meListed \|\| missing\.length\) throw new GroupKeysMissing\(missing\);/);
  assert.doesNotMatch(client, /members\.some\(\(userId\) => !devices\[userId\]\?\.length\)\) return send\(content\)/, 'groups no longer fall back to readable');
  assert.match(messaging, /if \(!isEnvelope\(content\) && isUserContent\(content\)\) \{\n\s+useChatStore\.getState\(\)\.updateMessage\(message\.id, \{ status: 'waiting', awaitingKeys: true \}\);\n\s+return 'waiting';/);
  const transmit = messaging.slice(messaging.indexOf('export async function transmitDirect'), messaging.indexOf('export async function handleRejected'));
  assert.doesNotMatch(transmit, /unencrypted: true/, 'sending never marks a message "sent unencrypted" (only messages arriving from old apps are labelled)');
  assert.match(groups, /enqueuePending\(useChatStore\.getState\(\)\.userId, id, plain\);/);
  assert.match(pending, /if \(error\?\.code === 'group-keys-missing'\) break;/);
});
