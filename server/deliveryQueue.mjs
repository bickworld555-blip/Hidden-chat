// The server as a short-lived queue (WhatsApp-style), not an archive of chat history.
//
// Every new message is sealed for a set of devices: the receiver's devices (or every group member's) and the sender's
// other devices, counting only devices with end-to-end keys that were active in the last 14 days (see devicesOf).
// Each target device gets a row in message_deliveries. A device acknowledges a message once it has stored it locally (media included); when every target has done so the message row, its
// reactions and its media are deleted. Nothing waits longer than QUEUE_TTL_MS (30 days).
//
// What stays after a message is gone is its route (message id, sender, receiver or group; no content) for 30 days,
// so a read receipt, reaction, "played" or delete sent later still reaches the right people. Those small events are
// queued per device in device_events for devices that are offline, and deleted when acknowledged.
import { randomUUID } from 'node:crypto';

export const QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A device not seen for this long is no longer waited for (like WhatsApp dropping idle linked devices).
export const INACTIVE_DEVICE_MS = 14 * 24 * 60 * 60 * 1000;
// A user with no signed-in device yet: any device they sign in with later can claim the message.
export const ANY_DEVICE = '*';
const MAX_ACK = 500;
const RELEASE_EVERY_MS = 10 * 60 * 1000;
const MAX_EVENTS_PER_DEVICE = 2000;

export function ensureDeliveryQueueSchema(db) {
  // Databases made before the key included user_id (two group members waiting on "any device" collided) are rebuilt.
  const keyColumns = db.prepare('PRAGMA table_info(message_deliveries)').all().filter((column) => column.pk > 0).map((column) => column.name);
  const rebuild = keyColumns.length > 0 && !keyColumns.includes('user_id');
  if (rebuild) {
    db.exec(`ALTER TABLE message_deliveries RENAME TO message_deliveries_old;
      DROP INDEX IF EXISTS message_deliveries_pending;
      DROP INDEX IF EXISTS message_deliveries_user;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_deliveries (
      message_id TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, delivered_at INTEGER, PRIMARY KEY (message_id, user_id, device_id)
    );
    CREATE INDEX IF NOT EXISTS message_deliveries_pending ON message_deliveries(device_id, delivered_at);
    CREATE INDEX IF NOT EXISTS message_deliveries_user ON message_deliveries(user_id, delivered_at);
    CREATE TABLE IF NOT EXISTS message_routes (
      message_id TEXT PRIMARY KEY, kind TEXT NOT NULL, sender_id TEXT NOT NULL, receiver_id TEXT, group_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS device_events (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, device_id TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS device_events_device ON device_events(device_id, created_at);
        CREATE TABLE IF NOT EXISTS backups (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, disk_name TEXT NOT NULL, byte_size INTEGER NOT NULL,
      kdf TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  if (rebuild) {
    db.exec(`INSERT INTO message_deliveries(message_id, kind, user_id, device_id, created_at, delivered_at)
        SELECT message_id, kind, user_id, device_id, created_at, delivered_at FROM message_deliveries_old;
      DROP TABLE message_deliveries_old;`);
  }
}

const cleanIds = (ids, limit = MAX_ACK) => (Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length < 120))].slice(0, limit) : []);

/**
 * `onlineDevices(userId)` → device ids with an open socket (they get events live, so nothing is queued for them).
 * `removeMessage(kind, messageId, { force })` → deletes a fully delivered message's row, reactions and media
 * (index.mjs owns those tables; without `force` it may keep a message that is still in use, such as an open poll).
 */
export function createDeliveryQueue({ db, onlineDevices = () => [], removeMessage, now = () => Date.now() }) {
  // The devices a message waits for: signed-in devices that published end-to-end keys (the ones messages are
  // encrypted for) and were active in the last 14 days. A session without keys (a script, a half-finished sign-in)
  // can never read an encrypted message, and an install left unused for weeks may never come back; waiting for either
  // would keep messages on the server for the full 30 days. When none of a user's devices qualifies, the message
  // still waits: for their keyed devices however long idle, else for any signed-in device.
  async function devicesOf(userId) {
    const at = now();
    const ids = (rows) => [...new Set(rows.map((row) => row.deviceId).filter(Boolean))];
    let keyed = [];
    try {
      keyed = await db.prepare(`SELECT s.device_id AS "deviceId", COALESCE(s.last_active_at, s.created_at, 0) AS "activeAt" FROM sessions s
        JOIN e2e_devices e ON e.user_id = s.user_id AND e.device_id = s.device_id
        WHERE s.user_id = ? AND (s.expires_at IS NULL OR s.expires_at > ?)`).all(userId, at);
    } catch { keyed = []; /* no end-to-end tables (tests, older databases) */ }
    const active = keyed.filter((row) => Number(row.activeAt) > at - INACTIVE_DEVICE_MS);
    if (active.length) return ids(active);
    if (keyed.length) return ids(keyed);
    return ids(await db.prepare(`SELECT device_id AS "deviceId" FROM sessions
      WHERE user_id = ? AND device_id IS NOT NULL AND (expires_at IS NULL OR expires_at > ?)`).all(userId, at));
  }

  async function addTargets(messageId, kind, userId, deviceIds, at) {
    const targets = deviceIds.length > 0 ? deviceIds : [ANY_DEVICE];
    for (const deviceId of targets) {
      await db.prepare(`INSERT INTO message_deliveries(message_id, kind, user_id, device_id, created_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(messageId, kind, userId, deviceId, at);
    }
  }

  /** A new one-to-one message: the receiver's devices and the sender's other devices must each store it. */
  async function trackDirect({ messageId, senderId, senderDeviceId = null, receiverId }) {
    const at = now();
    await db.prepare(`INSERT INTO message_routes(message_id, kind, sender_id, receiver_id, created_at)
      VALUES (?, 'direct', ?, ?, ?) ON CONFLICT DO NOTHING`).run(messageId, senderId, receiverId, at);
    await addTargets(messageId, 'direct', receiverId, await devicesOf(receiverId), at);
    const own = (await devicesOf(senderId)).filter((deviceId) => deviceId !== senderDeviceId);
    if (own.length > 0) await addTargets(messageId, 'direct', senderId, own, at);
  }

  /** A new group message: every member's devices (the sender's other devices included). */
  async function trackGroup({ messageId, groupId, senderId, senderDeviceId = null }) {
    const at = now();
    await db.prepare(`INSERT INTO message_routes(message_id, kind, sender_id, group_id, created_at)
      VALUES (?, 'group', ?, ?, ?) ON CONFLICT DO NOTHING`).run(messageId, senderId, groupId, at);
    const members = await db.prepare('SELECT user_id AS "userId" FROM group_members WHERE group_id = ?').all(groupId);
    for (const { userId } of members) {
      const devices = (await devicesOf(userId)).filter((deviceId) => userId !== senderId || deviceId !== senderDeviceId);
      if (userId === senderId && devices.length === 0) continue;
      await addTargets(messageId, 'group', userId, devices, at);
    }
  }

  /** Who a message was between, while its route lasts (the message row itself may already be gone). */
  async function routeOf(messageId) {
    if (typeof messageId !== 'string' || messageId.length >= 120) return null;
    return db.prepare(`SELECT kind, sender_id AS "senderId", receiver_id AS "receiverId", group_id AS "groupId", created_at AS "createdAt"
      FROM message_routes WHERE message_id = ?`).get(messageId);
  }

  /** Keeps a small event (receipt, reaction, played, deleted…) for this user's devices that are offline now. */
  async function queueEvent(userId, event) {
    const online = new Set(onlineDevices(userId));
    const at = now();
    const payload = JSON.stringify(event);
    for (const deviceId of await devicesOf(userId)) {
      if (online.has(deviceId)) continue;
      await db.prepare('INSERT INTO device_events(id, user_id, device_id, payload, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(randomUUID(), userId, deviceId, payload, at);
    }
  }

  /** What this device still has to store: message ids by kind, and queued events (oldest first). */
  async function pending(userId, deviceId) {
    const rows = await db.prepare(`SELECT message_id AS "messageId", kind FROM message_deliveries
      WHERE delivered_at IS NULL AND user_id = ? AND (device_id = ? OR device_id = ?) ORDER BY created_at ASC LIMIT 1000`)
      .all(userId, deviceId, ANY_DEVICE);
    const events = await db.prepare(`SELECT id, payload FROM device_events WHERE device_id = ? AND user_id = ?
      ORDER BY created_at ASC LIMIT ?`).all(deviceId, userId, MAX_EVENTS_PER_DEVICE);
    return {
      direct: rows.filter((row) => row.kind === 'direct').map((row) => row.messageId),
      group: rows.filter((row) => row.kind === 'group').map((row) => row.messageId),
      events: events.map((row) => { try { return { id: row.id, ...JSON.parse(row.payload) }; } catch { return null; } }).filter(Boolean),
    };
  }

  async function finishIfDelivered(messageId) {
    const left = await db.prepare('SELECT count(*) AS "count", min(kind) AS "kind" FROM message_deliveries WHERE message_id = ? AND delivered_at IS NULL').get(messageId);
    if (Number(left?.count ?? 0) > 0) return false;
    const route = await routeOf(messageId);
    await db.prepare('DELETE FROM message_deliveries WHERE message_id = ?').run(messageId);
    if (route) await removeMessage(route.kind, messageId);
    return true;
  }

  /**
   * This device has stored these messages (media included) and handled these events. Fully delivered messages are
   * deleted from the server. Returns the ids that were removed.
   */
  async function ack(userId, deviceId, { messageIds = [], eventIds = [] } = {}) {
    const at = now();
    const removed = [];
    for (const messageId of cleanIds(messageIds)) {
      // A message waiting for "any device" of this user is claimed by the first device that stores it.
      const updated = await db.prepare(`UPDATE message_deliveries SET delivered_at = ?
        WHERE message_id = ? AND user_id = ? AND (device_id = ? OR device_id = ?) AND delivered_at IS NULL`)
        .run(at, messageId, userId, deviceId, ANY_DEVICE);
      if (updated.changes && await finishIfDelivered(messageId)) removed.push(messageId);
    }
    const events = cleanIds(eventIds, MAX_EVENTS_PER_DEVICE);
    for (const eventId of events) {
      await db.prepare('DELETE FROM device_events WHERE id = ? AND device_id = ? AND user_id = ?').run(eventId, deviceId, userId);
    }
    return removed;
  }

  /**
   * Stops waiting for devices idle for 14 days or signed out. A delivery to such a device counts as done when the same
   * person already has the message elsewhere: they sent it (the sending device has it), another of their devices
   * stored it, or another of their devices is still active and will. Someone whose every device is idle keeps
   * waiting for them (the 30-day limit still applies), so nobody loses a message they never received.
   */
  let lastRelease = -Infinity;
  async function releaseInactiveDevices() {
    const at = now();
    const idleSince = at - INACTIVE_DEVICE_MS;
    const activeSession = (alias, row) => `EXISTS (SELECT 1 FROM sessions ${alias} WHERE ${alias}.user_id = ${row}.user_id
      AND ${alias}.device_id = ${row}.device_id AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)
      AND COALESCE(${alias}.last_active_at, ${alias}.created_at, 0) > ?)`;
    const rows = await db.prepare(`SELECT d.message_id AS "messageId", d.user_id AS "userId", d.device_id AS "deviceId" FROM message_deliveries d
      WHERE d.delivered_at IS NULL AND d.device_id <> ? AND NOT ${activeSession('s', 'd')}
        AND (EXISTS (SELECT 1 FROM message_routes r WHERE r.message_id = d.message_id AND r.sender_id = d.user_id)
          OR EXISTS (SELECT 1 FROM message_deliveries o WHERE o.message_id = d.message_id AND o.user_id = d.user_id
            AND o.device_id <> d.device_id AND (o.delivered_at IS NOT NULL OR o.device_id = ? OR ${activeSession('s2', 'o')})))
      LIMIT 5000`).all(ANY_DEVICE, at, idleSince, ANY_DEVICE, at, idleSince);
    const touched = new Set();
    for (const { messageId, userId, deviceId } of rows) {
      await db.prepare('UPDATE message_deliveries SET delivered_at = ? WHERE message_id = ? AND user_id = ? AND device_id = ? AND delivered_at IS NULL')
        .run(at, messageId, userId, deviceId);
      touched.add(messageId);
    }
    let removed = 0;
    for (const messageId of touched) if (await finishIfDelivered(messageId)) removed += 1;
    return { released: rows.length, removed };
  }

  /**
   * Housekeeping: anything older than 30 days goes (undelivered messages, routes, queued events), and messages
   * stored before this queue existed (no route) are deleted once delivered, or after 30 days.
   */
  async function sweep() {
    // Idle devices are checked every 10 minutes, not on every 30-second pass.
    let released = 0;
    if (now() - lastRelease >= RELEASE_EVERY_MS) {
      lastRelease = now();
      ({ released } = await releaseInactiveDevices());
    }
    const cutoff = now() - QUEUE_TTL_MS;
    const stale = await db.prepare('SELECT DISTINCT message_id AS "messageId" FROM message_deliveries WHERE created_at <= ?').all(cutoff);
    for (const { messageId } of stale) {
      const route = await routeOf(messageId);
      await db.prepare('DELETE FROM message_deliveries WHERE message_id = ?').run(messageId);
      if (route) await removeMessage(route.kind, messageId);
    }
    // Messages kept past delivery on purpose (an open poll, an unopened view once note) end at 30 days too.
    const kept = await db.prepare('SELECT message_id AS "messageId", kind FROM message_routes WHERE created_at <= ?').all(cutoff);
    for (const { messageId, kind } of kept) await removeMessage(kind, messageId, { force: true });
    await db.prepare('DELETE FROM message_routes WHERE created_at <= ?').run(cutoff);
    await db.prepare('DELETE FROM device_events WHERE created_at <= ?').run(cutoff);
    // History from before the queue: delivered or read one-to-one messages, and anything older than 30 days.
    const isoCutoff = new Date(cutoff).toISOString();
    const legacy = await db.prepare(`SELECT id FROM messages m
      WHERE NOT EXISTS (SELECT 1 FROM message_routes r WHERE r.message_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM message_deliveries d WHERE d.message_id = m.id)
        AND (m.status IN ('delivered', 'read') OR m.deleted_at IS NOT NULL OR m.created_at <= ?) LIMIT 2000`).all(isoCutoff);
    for (const { id } of legacy) await removeMessage('direct', id, { force: true });
    // Group history from before the queue was never kept on members' devices, so it is not deleted at once: it
    // follows the 30-day limit, which gives every member's app time to save it.
    const legacyGroup = await db.prepare(`SELECT id FROM group_messages g
      WHERE NOT EXISTS (SELECT 1 FROM message_routes r WHERE r.message_id = g.id) AND g.created_at <= ? LIMIT 2000`).all(cutoff);
    for (const { id } of legacyGroup) await removeMessage('group', id, { force: true });
    return { expired: stale.length, legacy: legacy.length + legacyGroup.length, released };
  }

  /** Counts for the admin dashboard (no message ids, no content). */
  async function stats() {
    const one = async (sql, ...values) => Number((await db.prepare(sql).get(...values))?.count ?? 0);
    return {
      pendingDeliveries: await one('SELECT count(*) AS "count" FROM message_deliveries WHERE delivered_at IS NULL'),
      pendingMessages: await one('SELECT count(DISTINCT message_id) AS "count" FROM message_deliveries WHERE delivered_at IS NULL'),
      waitingDevices: await one('SELECT count(DISTINCT device_id) AS "count" FROM message_deliveries WHERE delivered_at IS NULL'),
      queuedEvents: await one('SELECT count(*) AS "count" FROM device_events'),
      storedDirect: await one('SELECT count(*) AS "count" FROM messages'),
      storedGroup: await one('SELECT count(*) AS "count" FROM group_messages'),
      oldestPendingAt: Number((await db.prepare('SELECT min(created_at) AS "at" FROM message_deliveries WHERE delivered_at IS NULL').get())?.at ?? 0) || null,
    };
  }

  return { trackDirect, trackGroup, routeOf, queueEvent, pending, ack, sweep, releaseInactiveDevices, stats };
}
