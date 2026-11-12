// The 14-day rule: the delivery queue stops waiting for devices nobody has used in two weeks, without ever dropping a
// message for someone whose every device is idle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createDeliveryQueue, ensureDeliveryQueueSchema, INACTIVE_DEVICE_MS } from './deliveryQueue.mjs';

const DAY = 24 * 60 * 60 * 1000;

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL, device_name TEXT NOT NULL,
      expires_at INTEGER, created_at INTEGER, last_active_at INTEGER);
    CREATE TABLE e2e_devices (user_id TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (user_id, device_id));
    CREATE TABLE group_members (group_id TEXT NOT NULL, user_id TEXT NOT NULL);
  `);
  ensureDeliveryQueueSchema(db);
  const clock = { at: 100 * DAY };
  const removed = [];
  const queue = createDeliveryQueue({ db, now: () => clock.at, removeMessage: async (kind, id) => { removed.push(id); } });
  const device = (userId, deviceId, { idleDays = 0, keys = true } = {}) => {
    const at = clock.at - idleDays * DAY;
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, ?, ?)').run(`t-${deviceId}`, userId, deviceId, deviceId, at, at);
    if (keys) db.prepare('INSERT INTO e2e_devices VALUES (?, ?)').run(userId, deviceId);
  };
  const targets = (messageId) => db.prepare('SELECT user_id AS userId, device_id AS deviceId, delivered_at AS deliveredAt FROM message_deliveries WHERE message_id = ? ORDER BY device_id')
    .all(messageId).map((row) => ({ ...row }));
  return { db, clock, queue, device, targets, removed };
}

test('a new message does not wait for a device idle for more than 14 days', async () => {
  const { queue, device, targets } = setup();
  device('bob', 'bob-phone');
  device('bob', 'bob-old-tablet', { idleDays: 15 });
  device('ann', 'ann-phone');
  device('ann', 'ann-old-laptop', { idleDays: 40 });
  await queue.trackDirect({ messageId: 'm1', senderId: 'ann', senderDeviceId: 'ann-phone', receiverId: 'bob' });
  assert.deepEqual(targets('m1').map((row) => row.deviceId), ['bob-phone'], 'neither idle device is a target');
  assert.ok(INACTIVE_DEVICE_MS === 14 * DAY);
});

test('someone whose every device is idle is still waited for', async () => {
  const { queue, device, targets } = setup();
  device('ann', 'ann-phone');
  device('bob', 'bob-phone', { idleDays: 20 });
  await queue.trackDirect({ messageId: 'm2', senderId: 'ann', senderDeviceId: 'ann-phone', receiverId: 'bob' });
  assert.deepEqual(targets('m2').map((row) => row.deviceId), ['bob-phone']);
});

test('the sweep releases a device that went idle while a message waited, and the message leaves once the rest stored it', async () => {
  const { db, clock, queue, device, targets, removed } = setup();
  device('ann', 'ann-phone');
  device('bob', 'bob-phone');
  device('bob', 'bob-tablet');
  await queue.trackDirect({ messageId: 'm3', senderId: 'ann', senderDeviceId: 'ann-phone', receiverId: 'bob' });
  await queue.ack('bob', 'bob-phone', { messageIds: ['m3'] });
  assert.deepEqual(removed, [], 'still waiting for the tablet');

  // Two weeks later the tablet has not been used; the phone has.
  clock.at += 15 * DAY;
  db.prepare('UPDATE sessions SET last_active_at = ? WHERE device_id = ?').run(clock.at, 'bob-phone');
  const result = await queue.releaseInactiveDevices();
  assert.equal(result.released, 1);
  assert.deepEqual(removed, ['m3'], 'gone from the server: bob already has it on his phone');
  assert.deepEqual(targets('m3'), []);
});

test('the sweep keeps waiting when the idle device is the only one that has not got it yet and no other is active', async () => {
  const { clock, queue, device, targets, removed } = setup();
  device('ann', 'ann-phone');
  device('bob', 'bob-phone');
  await queue.trackDirect({ messageId: 'm4', senderId: 'ann', senderDeviceId: 'ann-phone', receiverId: 'bob' });
  clock.at += 20 * DAY;
  assert.equal((await queue.releaseInactiveDevices()).released, 0);
  assert.deepEqual(removed, []);
  assert.equal(targets('m4').length, 1, 'bob has not received it anywhere, so it keeps waiting (30 days at most)');
});

test("the sender's own idle devices are released: the device that sent the message has it", async () => {
  const { db, clock, queue, device, targets, removed } = setup();
  device('ann', 'ann-phone');
  device('ann', 'ann-old-install');
  device('bob', 'bob-phone');
  await queue.trackDirect({ messageId: 'm5', senderId: 'ann', senderDeviceId: 'ann-phone', receiverId: 'bob' });
  await queue.ack('bob', 'bob-phone', { messageIds: ['m5'] });
  assert.deepEqual(targets('m5').filter((row) => row.deliveredAt == null).map((row) => row.deviceId), ['ann-old-install']);
  clock.at += 15 * DAY;
  db.prepare('UPDATE sessions SET last_active_at = ? WHERE device_id = ?').run(clock.at, 'ann-phone');
  await queue.releaseInactiveDevices();
  assert.deepEqual(removed, ['m5']);
});

test('a signed-out device is released like an idle one', async () => {
  const { db, queue, device, removed } = setup();
  device('ann', 'ann-phone');
  device('bob', 'bob-phone');
  device('bob', 'bob-laptop');
  await queue.trackDirect({ messageId: 'm6', senderId: 'ann', senderDeviceId: 'ann-phone', receiverId: 'bob' });
  await queue.ack('bob', 'bob-phone', { messageIds: ['m6'] });
  db.prepare('DELETE FROM sessions WHERE device_id = ?').run('bob-laptop');
  await queue.releaseInactiveDevices();
  assert.deepEqual(removed, ['m6']);
});

test('in a group, every member without a signed-in device keeps their own "any device" target', async () => {
  const { db, queue, device, targets, removed } = setup();
  device('ann', 'ann-phone');
  for (const userId of ['ann', 'bob', 'cat']) db.prepare('INSERT INTO group_members VALUES (?, ?)').run('g1', userId);
  await queue.trackGroup({ messageId: 'gm1', groupId: 'g1', senderId: 'ann', senderDeviceId: 'ann-phone' });
  assert.deepEqual(targets('gm1').map((row) => `${row.userId}/${row.deviceId}`), ['bob/*', 'cat/*']);
  await queue.ack('bob', 'bob-new-phone', { messageIds: ['gm1'] });
  assert.deepEqual(removed, [], 'still waiting for cat');
  await queue.ack('cat', 'cat-new-phone', { messageIds: ['gm1'] });
  assert.deepEqual(removed, ['gm1']);
});

test('a database made with the old key is rebuilt in place, keeping its waiting deliveries', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE message_deliveries (message_id TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
    created_at INTEGER NOT NULL, delivered_at INTEGER, PRIMARY KEY (message_id, device_id));
    INSERT INTO message_deliveries VALUES ('m', 'group', 'bob', '*', 1, NULL);`);
  ensureDeliveryQueueSchema(db);
  ensureDeliveryQueueSchema(db); // idempotent
  const key = db.prepare('PRAGMA table_info(message_deliveries)').all().filter((column) => column.pk > 0).map((column) => column.name);
  assert.deepEqual(key, ['message_id', 'user_id', 'device_id']);
  db.prepare("INSERT INTO message_deliveries VALUES ('m', 'group', 'cat', '*', 1, NULL)").run();
  assert.equal(db.prepare('SELECT count(*) AS count FROM message_deliveries').get().count, 2);
});
