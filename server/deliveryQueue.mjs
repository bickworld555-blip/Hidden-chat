// The server as a short-lived queue (WhatsApp-style), not an archive of chat history.
//
// Every new message is sealed for a set of devices: all signed-in devices of the receiver (or of every group member)
// and the sender's other devices. Each target device gets a row in message_deliveries. A device acknowledges a
// message once it has stored it locally (media included); when every target has done so the message row, its
// reactions and its media are deleted. Nothing waits longer than QUEUE_TTL_MS (30 days).
//
// What stays after a message is gone is its route (message id, sender, receiver or group; no content) for 30 days,
// so a read receipt, reaction, "played" or delete sent later still reaches the right people. Those small events are
// queued per device in device_events for devices that are offline, and deleted when acknowledged.
import { randomUUID } from 'node:crypto';

export const QUEUE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A user with no signed-in device yet: any device they sign in with later can claim the message.
export const ANY_DEVICE = '*';
const MAX_ACK = 500;
const MAX_EVENTS_PER_DEVICE = 2000;

export function ensureDeliveryQueueSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_deliveries (
      message_id TEXT NOT NULL, kind TEXT NOT NULL, user_id TEXT NOT NULL, device_id TEXT NOT NULL,
      created_at INTEGER NOT NULL, delivered_at INTEGER, PRIMARY KEY (message_id, device_id)
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
}

const cleanIds = (ids, limit = MAX_ACK) => (Array.isArray(ids) ? [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0 && id.length < 120))].slice(0, limit) : []);

/**
 * `onlineDevices(userId)` → device ids with an open socket (they get events live, so nothing is queued for them).
 * `removeMessage(kind, messageId, { force })` → deletes a fully delivered message's row, reactions and media
 * (index.mjs owns those tables; without `force` it may keep a message that is still in use, such as an open poll).
 */
export function createDeliveryQueue({ db, onlineDevices = () => [], removeMessage, now = () => Date.now() }) {
  async function devicesOf(userId) {
    const rows = await db.prepare('SELECT DISTINCT device_id AS "deviceId" FROM sessions WHERE user_id = ? AND device_id IS NOT NULL').all(userId);
    return rows.map((row) => row.deviceId).filter(Boolean);
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
   * Housekeeping: anything older than 30 days goes (undelivered messages, routes, queued events), and messages
   * stored before this queue existed (no route) are deleted once delivered, or after 30 days.
   */
  async function sweep() {
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
    return { expired: stale.length, legacy: legacy.length + legacyGroup.length };
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

  return { trackDirect, trackGroup, routeOf, queueEvent, pending, ack, sweep, stats };
}
