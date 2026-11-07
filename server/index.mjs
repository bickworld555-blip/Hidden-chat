import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, linkSync, mkdirSync } from 'node:fs';
import { stat, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { contentDisposition, isInlineSafe, MAX_MEDIA_BYTES, resolveContentType, sanitizeFilename, SINGLE_REQUEST_MEDIA_BYTES } from './media.mjs';
import { isDisappearingDuration } from '../src/disappearing.js';
import { DEFAULT_ICE_SERVERS, normalizeIceServers, turnServerFromEnv } from '../src/rtc.js';
import { DOWNLOAD_LINK_TTL_MS, UPLOAD_CHUNK_BYTES, UPLOAD_STALE_MS } from '../src/transfer.js';
import { LIVE_DURATIONS } from '../src/geo.js';
import { displayNameError, initialsFor, normalizeDisplayName } from '../src/profile.js';
import { createPostgresDatabase, describeDatabaseError, isDatabaseUnavailable } from './database.mjs';
import { DEMO_USERS } from './demo.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const PAIRING_TTL_MS = 1000 * 60 * 2;
const deleteForEveryoneWindowMs = 24 * 60 * 60 * 1000;
const EXPIRY_SWEEP_MS = 30 * 1000;
// Bounds the request body of a "keep starred" clear; express.json already caps it at 16 kB.
const MAX_CLEAR_KEEP_IDS = 500;
const CALL_END_REASONS = new Set(['ended', 'no-answer', 'disconnected', 'busy', 'failed']);
const CALL_SIGNAL_TYPES = new Set(['offer', 'answer', 'ice', 'end', 'connected', 'ringing', 'media', 'video-request', 'video-accept', 'video-decline', 'video-cancel']);
const LIVE_ACTIONS = new Set(['request', 'accept', 'decline', 'update', 'stop']);
const MAX_CALL_PARTICIPANTS = 4;
const LIVE_DURATIONS_MS = new Set(LIVE_DURATIONS.map((duration) => duration.ms));
// Columns every user projection reads, so profile photos travel with the rest of the public profile.
const USER_COLUMNS = 'id, username, name, initials, color, avatar_disk_name, avatar_type, avatar_updated_at';
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
// Image formats accepted as profile photos, recognised by their leading bytes rather than the declared type.
const AVATAR_SIGNATURES = [
  { type: 'image/jpeg', extension: 'jpg', magic: [0xff, 0xd8, 0xff] },
  { type: 'image/png', extension: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/gif', extension: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { type: 'image/webp', extension: 'webp', magic: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
];

export function detectAvatarImage(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  return AVATAR_SIGNATURES.find(({ magic, at8 }) => magic.every((byte, index) => buffer[index] === byte)
    && (!at8 || at8.every((byte, index) => buffer[8 + index] === byte))) ?? null;
}
const scrypt = promisify(scryptCallback);
const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;
const USER_COLORS = ['blue', 'green', 'coral', 'yellow', 'violet'];
export const heartbeatIntervalForState = ({ visibility, idle }) => visibility !== 'visible' ? 120_000 : idle ? 60_000 : 25_000;

export function isAllowedAppOrigin(origin, configuredOrigins = []) {
  if (typeof origin !== 'string') return false;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return false;
  if (configuredOrigins.includes(origin)) return true;
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname === '::1' || hostname.endsWith('.localhost')) return true;
  if (hostname.endsWith('.ngrok-free.dev') || hostname.endsWith('.ngrok.io')) return true;
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

const digest = (value) => createHash('sha256').update(value).digest('hex');
const normalizeUsername = (value) => typeof value === 'string'
  ? value.trim().replace(/^@+/, '').toLowerCase()
  : '';
const json = (socket, event) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
};

export function createChatServer({
  port = Number(process.env.PORT ?? 4174),
  host = process.env.HOST || '0.0.0.0',
  databasePath,
  databaseUrl = process.env.DATABASE_URL,
  database = null,
  dataDirectory = process.env.RELAY_DATA_DIRECTORY || join(directory, '..', '.data'),
  seedDemo = process.env.NODE_ENV !== 'production' && process.env.RELAY_SEED_DEMO === 'true',
  callTimeoutMs = Number(process.env.CALL_RING_TIMEOUT_MS) || 0,
  allowedOrigins = process.env.RELAY_ALLOWED_ORIGINS ?? '',
  webDirectory = join(directory, '..', 'dist'),
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer from 0 to 65535.');
  if (process.env.NODE_ENV === 'production' && port === 0) throw new Error('Production requires a fixed nonzero PORT.');
  if (process.env.NODE_ENV === 'production' && !databaseUrl && !database) throw new Error('Production requires DATABASE_URL; SQLite is development-only.');
  if (process.env.NODE_ENV === 'production' && seedDemo) throw new Error('Demo seeding is not allowed in production.');
  if (process.env.NODE_ENV === 'production') {
    const origins = Array.isArray(allowedOrigins) ? allowedOrigins : String(allowedOrigins).split(',');
    if (!origins.some((origin) => origin.trim())) throw new Error('Production requires RELAY_ALLOWED_ORIGINS.');
    for (const origin of origins.filter((origin) => origin.trim())) {
      const url = new URL(origin.trim());
      if (url.protocol !== 'https:' || url.origin !== origin.trim()) throw new Error('Production origins must be exact HTTPS origins without paths or credentials.');
    }
  }
  const mediaDirectory = join(dataDirectory, 'media');
  mkdirSync(dataDirectory, { recursive: true });
  mkdirSync(mediaDirectory, { recursive: true });
  const db = database ?? (databaseUrl
    ? createPostgresDatabase({ env: { ...process.env, DATABASE_URL: databaseUrl } })
    : new DatabaseSync(databasePath ?? join(dataDirectory, 'relay.sqlite')));
  if (db.dialect !== 'postgres') {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT NOT NULL,
      expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      name TEXT NOT NULL,
      initials TEXT NOT NULL,
      color TEXT NOT NULL,
      dob TEXT,
      password_hash TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS contacts (
      owner_id TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      saved INTEGER NOT NULL DEFAULT 1,
      hidden INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(owner_id, contact_id),
      CHECK(owner_id <> contact_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('sent', 'delivered', 'read'))
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      disk_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_conversation
      ON messages(sender_id, receiver_id, created_at);
    CREATE TABLE IF NOT EXISTS pairing_codes (
      code_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  const sessionExpiry = db.prepare("PRAGMA table_info(sessions)").all().find((column) => column.name === 'expires_at');
  if (sessionExpiry?.notnull) {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE sessions_migrated (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        expires_at INTEGER
      );
      DROP TABLE sessions;
      ALTER TABLE sessions_migrated RENAME TO sessions;
      COMMIT;`);
  }
  if (!db.prepare("PRAGMA table_info(messages)").all().some((column) => column.name === 'deleted_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN deleted_at INTEGER');
  }
  const messageColumns = new Set(db.prepare("PRAGMA table_info(messages)").all().map((column) => column.name));
  if (!messageColumns.has('reply_to_id')) db.exec('ALTER TABLE messages ADD COLUMN reply_to_id TEXT');
  if (!messageColumns.has('forwarded')) db.exec('ALTER TABLE messages ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0');
  if (!messageColumns.has('expires_at')) db.exec('ALTER TABLE messages ADD COLUMN expires_at INTEGER');
  db.exec(`CREATE INDEX IF NOT EXISTS messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL`);
  // One disappearing-messages timer per conversation, shared by both people (user_a < user_b).
  db.exec(`CREATE TABLE IF NOT EXISTS chat_settings (
    user_a TEXT NOT NULL,
    user_b TEXT NOT NULL,
    disappear_seconds INTEGER NOT NULL DEFAULT 0,
    updated_by TEXT,
    updated_at INTEGER,
    PRIMARY KEY(user_a, user_b),
    CHECK(user_a < user_b)
  )`);
  // In-progress resumable uploads; the file on disk grows to byte_size, then the row becomes a media row.
  db.exec(`CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    disk_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS message_reactions (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    emoji TEXT NOT NULL,
    PRIMARY KEY(message_id, user_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS message_hidden (
    user_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY(user_id, message_id)
  )`);
  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  if (!userColumns.has('dob')) db.exec('ALTER TABLE users ADD COLUMN dob TEXT');
  if (!userColumns.has('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  if (!userColumns.has('avatar_disk_name')) db.exec('ALTER TABLE users ADD COLUMN avatar_disk_name TEXT');
  if (!userColumns.has('avatar_type')) db.exec('ALTER TABLE users ADD COLUMN avatar_type TEXT');
  if (!userColumns.has('avatar_updated_at')) db.exec('ALTER TABLE users ADD COLUMN avatar_updated_at INTEGER');
  // A contacts row is a link between two people. `saved` = in the owner's contact book; `hidden` = the thread was
  // deleted from the owner's chat list (a saved contact stays in the book). Older rows were always saved.
  const contactColumns = new Set(db.prepare("PRAGMA table_info(contacts)").all().map((column) => column.name));
  if (!contactColumns.has('saved')) db.exec('ALTER TABLE contacts ADD COLUMN saved INTEGER NOT NULL DEFAULT 1');
  if (!contactColumns.has('hidden')) db.exec('ALTER TABLE contacts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  }
  const upsertLink = db.prepare(`INSERT INTO contacts(owner_id, contact_id, created_at, saved, hidden) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(owner_id, contact_id) DO UPDATE SET saved = CASE WHEN contacts.saved > excluded.saved THEN contacts.saved ELSE excluded.saved END, hidden = 0`);
  // Links `peerId` into `ownerId`'s chat list (un-hiding a deleted thread); `save` also puts them in the contact book.
  async function linkUsers(ownerId, peerId, { save = false } = {}) {
    if (!ownerId || !peerId || ownerId === peerId) return;
    (await upsertLink.run(ownerId, peerId, Date.now(), save ? 1 : 0));
  }
  const linkRow = db.prepare("SELECT saved, hidden FROM contacts WHERE owner_id = ? AND contact_id = ?");
  const insertUser = db.prepare(`INSERT INTO users(id, username, name, initials, color, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`);
  const seedContact = db.prepare("INSERT INTO contacts(owner_id, contact_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING");
  async function seedDemoUsers() {
    if (!seedDemo) return;
    for (const profile of Object.values(DEMO_USERS)) {
      await insertUser.run(profile.id, profile.username, profile.name, profile.initials, profile.color, Date.now());
    }
    for (const owner of Object.keys(DEMO_USERS)) {
      for (const contact of Object.keys(DEMO_USERS)) {
        if (owner !== contact) await seedContact.run(owner, contact, Date.now());
      }
    }
  }

  // The quote shown above a reply is read from the quoted message so both sides see the same, current text;
  // a message deleted for everyone is quoted without its content.
  const quotedMessage = db.prepare(`SELECT id, sender_id AS "senderId", content, deleted_at IS NOT NULL AS "deleted"
    FROM messages WHERE id = ?`);
  async function presentMessage({ replyToId, forwarded, expiresAt, ...message }) {
    const quoted = replyToId ? (await quotedMessage.get(replyToId)) : null;
    return {
      ...message,
      ...(quoted ? { replyTo: quoted.deleted ? { id: quoted.id, senderId: quoted.senderId, deleted: true } : { id: quoted.id, senderId: quoted.senderId, content: quoted.content } } : {}),
      ...(forwarded ? { forwarded: true } : {}),
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
    };
  }

  const pairOf = (left, right) => (left < right ? [left, right] : [right, left]);
  const disappearingSetting = db.prepare("SELECT disappear_seconds AS \"seconds\" FROM chat_settings WHERE user_a = ? AND user_b = ?");
  async function disappearSecondsFor(left, right) {
    return (await disappearingSetting.get(...pairOf(left, right)))?.seconds ?? 0;
  }

  function mediaIdOf(content) {
    return content.startsWith('media:') || content.startsWith('voice:') ? content.slice(6).split(':', 1)[0] : null;
  }

  // Expired disappearing messages become deleted-for-everyone tombstones, so devices that were offline drop them on
  // their next history sync; their media is removed from disk.
  async function expireMessages(now = Date.now()) {
    const expired = (await db.prepare(`SELECT id, sender_id AS "senderId", receiver_id AS "receiverId", content FROM messages
      WHERE expires_at IS NOT NULL AND expires_at <= ? AND deleted_at IS NULL`).all(now));
    let deleted = 0;
    for (const row of expired) {
      const updated = await db.prepare("UPDATE messages SET content = '', deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(now, row.id);
      if (!updated.changes) continue;
      deleted += 1;
      (await db.prepare("DELETE FROM message_reactions WHERE message_id = ?").run(row.id));
      const mediaId = mediaIdOf(row.content);
      const media = mediaId ? (await db.prepare("SELECT disk_name AS \"diskName\" FROM media WHERE id = ?").get(mediaId)) : null;
      if (media) {
        (await db.prepare("DELETE FROM media WHERE id = ?").run(mediaId));
        unlink(join(mediaDirectory, media.diskName)).catch(() => {});
      }
      const event = { type: 'message:deleted', messageId: row.id, scope: 'everyone', reason: 'expired' };
      broadcastUser(row.senderId, event);
      broadcastUser(row.receiverId, event);
    }
    return deleted;
  }

  async function areLinked(left, right) {
    return Boolean((await db.prepare(`SELECT 1 FROM contacts
      WHERE (owner_id = ? AND contact_id = ?) OR (owner_id = ? AND contact_id = ?) LIMIT 1`)
      .get(left, right, right, left))
      || (await db.prepare(`SELECT 1 FROM messages
      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) LIMIT 1`)
      .get(left, right, right, left)));
  }

  // Hides every current message of a conversation for one user, except the ids they keep (starred, on their device).
  async function hideConversation(userId, peerId, keepIds = []) {
    const keep = new Set(keepIds);
    const rows = (await db.prepare(`SELECT id FROM messages
      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)`).all(userId, peerId, peerId, userId));
    const hide = db.prepare("INSERT INTO message_hidden(user_id, message_id) VALUES (?, ?) ON CONFLICT DO NOTHING");
    let hidden = 0;
    for (const row of rows) {
      if (keep.has(row.id)) continue;
      hide.run(userId, row.id);
      hidden += 1;
    }
    return hidden;
  }

  const app = express();
  app.disable('x-powered-by');
  const configuredOrigins = (Array.isArray(allowedOrigins) ? allowedOrigins : String(allowedOrigins).split(','))
    .map((origin) => origin.trim())
    .filter(Boolean);
  function originAllowed(origin) {
    if (process.env.NODE_ENV === 'production') return configuredOrigins.includes(origin);
    return isAllowedAppOrigin(origin, configuredOrigins);
  }
  app.use((request, response, next) => {
    const origin = request.get('origin');
    if (!origin) return next();
    if (!originAllowed(origin)) return response.status(403).json({ error: 'Origin is not allowed.' });
    response.set('Access-Control-Allow-Origin', origin);
    response.vary('Origin');
    if (request.method === 'OPTIONS') {
      response.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      response.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-File-Name,ngrok-skip-browser-warning');
      return response.status(204).end();
    }
    return next();
  });
  app.use(express.json({ limit: '16kb' }));
  const server = createServer(app);
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    handleProtocols(protocols) { return protocols.has('relay.v1') ? 'relay.v1' : false; },
  });
  const connections = new Map();
  const activeCalls = new Map();

  // Live location sessions live only in memory: positions are relayed, never stored.
  const liveSessions = new Map();

  function endLiveSession(sessionId, reason, exceptSocket) {
    const session = liveSessions.get(sessionId);
    if (!session) return;
    clearTimeout(session.timer);
    liveSessions.delete(sessionId);
    for (const [userId, peerId] of [[session.initiatorId, session.peerId], [session.peerId, session.initiatorId]]) {
      broadcastUser(userId, { type: 'location:live', action: 'stop', sessionId, from: peerId, reason }, exceptSocket);
    }
  }

  function finishCall(callId, reason, exceptSocket) {
    const activeCall = activeCalls.get(callId);
    if (!activeCall) return;
    clearTimeout(activeCall.timer);
    activeCalls.delete(callId);
    const event = {
      type: 'call:signal',
      from: reason === 'no-answer' ? activeCall.calleeId : activeCall.callerId,
      callId,
      mode: activeCall.mode,
      signalId: randomUUID(),
      signal: { type: 'end', reason },
    };
    // Every device of both people hears the end, so unanswered devices stop ringing too.
    broadcastUser(activeCall.callerId, event, exceptSocket);
    broadcastUser(activeCall.calleeId, event, exceptSocket);
  }

  // Once a device owns its side of the call, negotiation stays on that device only.
  function deliverCallSignal(activeCall, targetId, event) {
    const pinned = activeCall && (targetId === activeCall.callerId ? activeCall.callerSocket : activeCall.calleeSocket);
    if (pinned?.readyState === WebSocket.OPEN) {
      json(pinned, event);
      return 1;
    }
    return broadcastUser(targetId, event);
  }

  async function getSession(token) {
    if (!token || token.length > 128) return null;
    const row = (await db.prepare("SELECT * FROM sessions WHERE token_hash = ? AND (expires_at IS NULL OR expires_at > ?)")
      .get(digest(token), Date.now()));
    if (!row) return null;
    const user = (await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(row.user_id));
    return user ? { ...row, user: publicUser(user) } : null;
  }

  async function requireSession(request, response, next) {
    const authorization = request.get('authorization') ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const session = (await getSession(token));
    if (!session) return response.status(401).json({ error: 'A valid session is required.' });
    request.session = session;
    return next();
  }

  async function issueSession(userId, deviceName) {
    const token = randomBytes(32).toString('base64url');
    const deviceId = randomUUID();
    (await db.prepare(`INSERT INTO sessions(token_hash, user_id, device_id, device_name, expires_at)
      VALUES (?, ?, ?, ?, ?)`)
      .run(digest(token), userId, deviceId, deviceName, null));
    const user = (await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(userId));
    return { token, deviceId, deviceName, user: publicUser(user) };
  }

  function publicUser(row) {
    const avatar = row.avatar_disk_name ? `/api/v1/users/${encodeURIComponent(row.id)}/avatar?v=${row.avatar_updated_at ?? 0}` : null;
    return { id: row.id, username: row.username, name: row.name, initials: row.initials, color: row.color, avatar };
  }

  async function hashPassword(password) {
    const salt = randomBytes(16);
    const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
    return `scrypt$32768$8$1$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
  }

  async function verifyPassword(password, encoded) {
    const [algorithm, n, r, p, saltText, hashText] = encoded.split('$');
    if (algorithm !== 'scrypt' || n !== '32768' || r !== '8' || p !== '1' || !saltText || !hashText) return false;
    const expected = Buffer.from(hashText, 'base64url');
    const actual = Buffer.from(await scrypt(password, Buffer.from(saltText, 'base64url'), expected.length, {
      N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024,
    }));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  function validDob(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && date.getTime() <= Date.now();
  }

  function userSockets(userId) {
    return connections.get(userId) ?? new Set();
  }

  function broadcastUser(userId, event, except) {
    let delivered = 0;
    for (const socket of userSockets(userId)) {
      if (socket === except) continue;
      json(socket, event);
      delivered += 1;
    }
    return delivered;
  }

  function broadcastPresence(userId) {
    const event = { type: 'presence:update', userId, status: userSockets(userId).size ? 'online' : 'offline' };
    for (const sockets of connections.values()) for (const socket of sockets) json(socket, event);
  }

  function heartbeatDelay(socket) {
    return heartbeatIntervalForState({ visibility: socket.backgrounded ? 'hidden' : 'visible', idle: socket.idle });
  }

  function scheduleHeartbeat(socket, delay = heartbeatDelay(socket)) {
    clearTimeout(socket.heartbeatTimer);
    socket.heartbeatTimer = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.awaitingPong) {
        // Protect active calls from being terminated by sudden ping hiccups
        const isInActiveCall = [...activeCalls.values()].some(
          (c) => c.callerSocket === socket || c.calleeSocket === socket
        );
        if (!isInActiveCall) {
          socket.terminate();
          return;
        }
        socket.awaitingPong = false;
      }
      socket.awaitingPong = true;
      socket.ping();
      scheduleHeartbeat(socket, socket.backgrounded ? 45_000 : 15_000);
    }, delay);
    socket.heartbeatTimer.unref?.();
  }

  app.get('/api/v1/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/api/v1/ready', async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    await db.ready?.();
    response.json({ status: 'ok' });
  });

  app.get('/api/v1/rtc-config', requireSession, (_request, response) => {
    let configured = [];
    if (process.env.RELAY_ICE_SERVERS) {
      try {
        const parsed = JSON.parse(process.env.RELAY_ICE_SERVERS);
        if (Array.isArray(parsed)) configured = parsed;
      } catch {
        return response.status(503).json({ error: 'Server ICE configuration is invalid.' });
      }
    }
    const turn = turnServerFromEnv({
      url: process.env.RELAY_TURN_URL,
      username: process.env.RELAY_TURN_USERNAME,
      credential: process.env.RELAY_TURN_CREDENTIAL,
    });
    response.json({ iceServers: normalizeIceServers([...DEFAULT_ICE_SERVERS, ...(turn ? [turn] : []), ...configured]) });
  });

  app.get('/api/v1/auth/availability', async (request, response) => {
    const username = normalizeUsername(request.query.username);
    if (!USERNAME_PATTERN.test(username)) {
      return response.json({ valid: false, available: false, reason: 'Use 3–24 letters, numbers, or underscores.' });
    }
    const exists = (await db.prepare("SELECT 1 FROM users WHERE lower(username) = lower(?)").get(username));
    response.json({ valid: true, available: !exists, username });
  });

  app.post('/api/v1/auth/register', async (request, response) => {
    const username = normalizeUsername(request.body?.username);
    if (!USERNAME_PATTERN.test(username)) {
      return response.status(400).json({ error: 'Use 3–24 letters, numbers, or underscores.' });
    }
    const password = request.body?.password;
    const dob = request.body?.dob;
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
      return response.status(400).json({ error: 'Password must be 10–128 characters.' });
    }
    if (!validDob(dob)) return response.status(400).json({ error: 'Enter a valid date of birth.' });
    const userId = randomUUID();
    const initials = username.slice(0, 2).toUpperCase();
    const color = USER_COLORS[createHash('sha256').update(username).digest()[0] % USER_COLORS.length];
    const passwordHash = await hashPassword(password);
    try {
      (await db.prepare(`INSERT INTO users(id, username, name, initials, color, dob, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(userId, username, `@${username}`, initials, color, dob, passwordHash, Date.now()));
    } catch (error) {
      if (error.code === '23505' || error.code === 'ERR_SQLITE_CONSTRAINT_UNIQUE' || error.errcode === 2067) {
        return response.status(409).json({ error: `@${username} is already taken. Try another handle.` });
      }
      throw error;
    }
    const session = (await issueSession(userId, 'Browser'));
    response.status(201).json(session);
  });

  app.post('/api/v1/auth/login', async (request, response) => {
    const identity = typeof request.body?.identity === 'string' ? request.body.identity.trim() : '';
    const password = request.body?.password;
    if (!identity || typeof password !== 'string' || password.length > 128) {
      return response.status(400).json({ error: 'Enter your username or unique ID and password.' });
    }
    const username = normalizeUsername(identity);
    const user = USERNAME_PATTERN.test(username)
      ? (await db.prepare("SELECT id, password_hash FROM users WHERE lower(username) = lower(?)").get(username))
      : (await db.prepare("SELECT id, password_hash FROM users WHERE id = ?").get(identity));
    const valid = user?.password_hash && await verifyPassword(password, user.password_hash);
    if (!valid) return response.status(401).json({ error: 'Credentials do not match.' });
    response.json((await issueSession(user.id, 'Browser')));
  });

  app.get('/api/v1/me', requireSession, (request, response) => {
    const { session } = request;
    response.json({
      user: session.user,
      device: { id: session.device_id, name: session.device_name },
      expiresAt: session.expires_at,
    });
  });

  // --- Profile photos: stored per user, served to signed-in users, announced to everyone online. ---

  const avatarDirectory = join(dataDirectory, 'avatars');
  mkdirSync(avatarDirectory, { recursive: true });

  async function broadcastProfile(userId) {
    const row = (await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(userId));
    if (!row) return null;
    const user = publicUser(row);
    const event = { type: 'user:updated', user };
    for (const sockets of connections.values()) for (const socket of sockets) json(socket, event);
    return user;
  }

  app.put('/api/v1/me/avatar', requireSession, express.raw({ type: () => true, limit: MAX_AVATAR_BYTES }), async (request, response) => {
    const image = detectAvatarImage(request.body);
    if (!image) return response.status(415).json({ error: 'Choose a JPEG, PNG, WebP or GIF image.' });
    const userId = request.session.user_id;
    const previous = (await db.prepare("SELECT avatar_disk_name FROM users WHERE id = ?").get(userId))?.avatar_disk_name;
    const updatedAt = Date.now();
    const diskName = `${userId}-${updatedAt}.${image.extension}`;
    await writeFile(join(avatarDirectory, diskName), request.body, { flag: 'wx' });
    (await db.prepare("UPDATE users SET avatar_disk_name = ?, avatar_type = ?, avatar_updated_at = ? WHERE id = ?").run(diskName, image.type, updatedAt, userId));
    if (previous) await unlink(join(avatarDirectory, previous)).catch(() => {});
    response.json({ user: (await broadcastProfile(userId)) });
  });

  app.delete('/api/v1/me/avatar', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const previous = (await db.prepare("SELECT avatar_disk_name FROM users WHERE id = ?").get(userId))?.avatar_disk_name;
    (await db.prepare("UPDATE users SET avatar_disk_name = NULL, avatar_type = NULL, avatar_updated_at = ? WHERE id = ?").run(Date.now(), userId));
    if (previous) await unlink(join(avatarDirectory, previous)).catch(() => {});
    response.json({ user: (await broadcastProfile(userId)) });
  });

  app.get('/api/v1/users/:id/avatar', requireSession, async (request, response) => {
    const row = (await db.prepare("SELECT avatar_disk_name, avatar_type FROM users WHERE id = ?").get(request.params.id));
    if (!row?.avatar_disk_name) return response.status(404).json({ error: 'No profile photo.' });
    response.set({
      'Content-Type': row.avatar_type,
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      // The URL carries the version, so a photo can be cached until it changes.
      'Cache-Control': 'private, max-age=86400, immutable',
    });
    response.sendFile(row.avatar_disk_name, { root: avatarDirectory, cacheControl: false, dotfiles: 'deny' }, (error) => {
      if (error && !response.headersSent) response.status(404).json({ error: 'No profile photo.' });
    });
  });

  app.post('/api/v1/media', requireSession, express.raw({ type: () => true, limit: SINGLE_REQUEST_MEDIA_BYTES }), async (request, response) => {
    const receiverId = String(request.query.receiverId ?? '');
    const receiver = (await db.prepare("SELECT 1 FROM users WHERE id = ?").get(receiverId));
    if (!receiver || receiverId === request.session.user_id) return response.status(400).json({ error: 'Choose a valid conversation.' });
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) return response.status(400).json({ error: 'Choose a non-empty file.' });
    let rawName = String(request.get('x-file-name') ?? 'attachment').slice(0, 1024);
    try { rawName = decodeURIComponent(rawName); } catch { return response.status(400).json({ error: 'Filename encoding is invalid.' }); }
    const filename = sanitizeFilename(rawName);
    const contentType = resolveContentType(request.get('content-type'), filename);
    const id = randomUUID();
    const diskName = `${id}.blob`;
    await writeFile(join(mediaDirectory, diskName), request.body, { flag: 'wx' });
    (await db.prepare(`INSERT INTO media(id, sender_id, receiver_id, filename, content_type, byte_size, disk_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, request.session.user_id, receiverId, filename, contentType, request.body.length, diskName, Date.now()));
    response.status(201).json({ id, filename, contentType, byteSize: request.body.length });
  });

  // --- Resumable uploads: files up to MAX_MEDIA_BYTES arrive in UPLOAD_CHUNK_BYTES requests streamed to disk. ---

  const busyUploads = new Set();

  async function ownUpload(request, response) {
    const upload = (await db.prepare("SELECT * FROM uploads WHERE id = ? AND owner_id = ?").get(request.params.id, request.session.user_id));
    if (!upload) response.status(404).json({ error: 'Upload not found.' });
    return upload;
  }

  async function discardUpload(upload) {
    (await db.prepare("DELETE FROM uploads WHERE id = ?").run(upload.id));
    await unlink(join(mediaDirectory, upload.disk_name)).catch(() => {});
  }

  async function discardStaleUploads() {
    const stale = (await db.prepare("SELECT * FROM uploads WHERE updated_at < ?").all(Date.now() - UPLOAD_STALE_MS));
    for (const upload of stale) await discardUpload(upload);
  }

  app.post('/api/v1/uploads', requireSession, async (request, response) => {
    const { receiverId, byteSize } = request.body ?? {};
    const receiver = typeof receiverId === 'string' && (await db.prepare("SELECT 1 FROM users WHERE id = ?").get(receiverId));
    if (!receiver || receiverId === request.session.user_id) return response.status(400).json({ error: 'Choose a valid conversation.' });
    if (!Number.isInteger(byteSize) || byteSize <= 0) return response.status(400).json({ error: 'Choose a non-empty file.' });
    if (byteSize > MAX_MEDIA_BYTES) return response.status(413).json({ error: `Files can be up to ${MAX_MEDIA_BYTES / 1024 ** 3} GB.` });
    const filename = sanitizeFilename(String(request.body?.filename ?? 'attachment').slice(0, 1024));
    const contentType = resolveContentType(request.body?.contentType, filename);
    const id = randomUUID();
    const diskName = `${id}.blob`;
    await writeFile(join(mediaDirectory, diskName), '', { flag: 'wx' });
    const now = Date.now();
    (await db.prepare(`INSERT INTO uploads(id, owner_id, receiver_id, filename, content_type, byte_size, received, disk_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
      .run(id, request.session.user_id, receiverId, filename, contentType, byteSize, diskName, now, now));
    response.status(201).json({ uploadId: id, chunkBytes: UPLOAD_CHUNK_BYTES, received: 0, byteSize, filename, contentType });
  });

  app.get('/api/v1/uploads/:id', requireSession, async (request, response) => {
    const upload = (await ownUpload(request, response));
    if (upload) response.json({ uploadId: upload.id, received: upload.received, byteSize: upload.byte_size, chunkBytes: UPLOAD_CHUNK_BYTES });
  });

  app.delete('/api/v1/uploads/:id', requireSession, async (request, response) => {
    const upload = (await ownUpload(request, response));
    if (!upload) return;
    await discardUpload(upload);
    response.status(204).end();
  });

  // Appends one chunk at X-Upload-Offset. The body is streamed straight into the file; a mismatched offset
  // returns 409 with the byte count on disk so the client resumes from there.
  app.put('/api/v1/uploads/:id', requireSession, async (request, response) => {
    const upload = (await ownUpload(request, response));
    if (!upload) return request.resume();
    const offset = Number.parseInt(request.get('x-upload-offset') ?? '', 10);
    if (!Number.isInteger(offset) || offset !== upload.received) {
      request.resume();
      return response.status(409).json({ error: 'Upload offset does not match.', received: upload.received });
    }
    if (busyUploads.has(upload.id)) {
      request.resume();
      return response.status(409).json({ error: 'A chunk is already being written.', received: upload.received });
    }
    const remaining = upload.byte_size - upload.received;
    const limit = Math.min(UPLOAD_CHUNK_BYTES, remaining);
    const declared = Number.parseInt(request.get('content-length') ?? '', 10);
    if (Number.isInteger(declared) && declared > limit) {
      request.resume();
      return response.status(413).json({ error: 'Chunk is larger than the remaining file size.', received: upload.received });
    }
    busyUploads.add(upload.id);
    let written = 0;
    const path = join(mediaDirectory, upload.disk_name);
    try {
      const sink = createWriteStream(path, { flags: 'r+', start: upload.received });
      await pipeline(request, async function* (source) {
        for await (const chunk of source) {
          written += chunk.length;
          if (written > limit) throw Object.assign(new Error('Chunk is larger than the remaining file size.'), { status: 413 });
          yield chunk;
        }
      }, sink);
      const received = upload.received + written;
      (await db.prepare("UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?").run(received, Date.now(), upload.id));
      response.json({ received, byteSize: upload.byte_size });
    } catch (error) {
      // Keep what was durably written so the client can resume instead of restarting the whole file.
      const size = await stat(path).then((info) => info.size).catch(() => upload.received);
      const received = Math.min(Math.max(upload.received, size), upload.byte_size);
      (await db.prepare("UPDATE uploads SET received = ?, updated_at = ? WHERE id = ?").run(received, Date.now(), upload.id));
      if (!response.headersSent) response.status(error.status ?? 500).json({ error: error.message || 'Chunk upload failed.', received });
    } finally {
      busyUploads.delete(upload.id);
    }
  });

  app.post('/api/v1/uploads/:id/complete', requireSession, async (request, response) => {
    const upload = (await ownUpload(request, response));
    if (!upload) return;
    const size = await stat(join(mediaDirectory, upload.disk_name)).then((info) => info.size).catch(() => -1);
    if (upload.received !== upload.byte_size || size !== upload.byte_size) {
      return response.status(409).json({ error: 'The upload is incomplete.', received: upload.received, byteSize: upload.byte_size });
    }
    (await db.prepare(`INSERT INTO media(id, sender_id, receiver_id, filename, content_type, byte_size, disk_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(upload.id, upload.owner_id, upload.receiver_id, upload.filename, upload.content_type, upload.byte_size, upload.disk_name, Date.now()));
    (await db.prepare("DELETE FROM uploads WHERE id = ?").run(upload.id));
    response.status(201).json({ id: upload.id, filename: upload.filename, contentType: upload.content_type, byteSize: upload.byte_size });
  });

  // --- Downloads: a short-lived link lets the browser stream straight to disk (with range resume) without a header. ---

  const downloadLinks = new Map();

  function pruneDownloadLinks(now = Date.now()) {
    for (const [token, link] of downloadLinks) if (link.expiresAt <= now) downloadLinks.delete(token);
  }

  async function mediaFor(userId, mediaId) {
    return (await db.prepare(`SELECT id, filename, content_type AS "contentType", disk_name AS "diskName", byte_size AS "byteSize"
      FROM media WHERE id = ? AND (sender_id = ? OR receiver_id = ?)`).get(mediaId, userId, userId));
  }

  app.post('/api/v1/media/:id/link', requireSession, async (request, response) => {
    const media = (await mediaFor(request.session.user_id, request.params.id));
    if (!media) return response.status(404).json({ error: 'Attachment not found.' });
    pruneDownloadLinks();
    const token = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + DOWNLOAD_LINK_TTL_MS;
    downloadLinks.set(token, { mediaId: media.id, userId: request.session.user_id, expiresAt });
    response.json({ url: `/api/v1/media/${encodeURIComponent(media.id)}?dl=${token}`, expiresAt, filename: media.filename, byteSize: media.byteSize });
  });

  function requireSessionOrDownloadLink(request, response, next) {
    const token = typeof request.query.dl === 'string' ? request.query.dl : '';
    if (!token) return requireSession(request, response, next);
    pruneDownloadLinks();
    const link = downloadLinks.get(token);
    if (!link || link.mediaId !== request.params.id) return response.status(401).json({ error: 'This download link is invalid or has expired.' });
    request.session = { user_id: link.userId };
    return next();
  }

  // GET downloads the original bytes; HEAD (answered by the same route) reports type and size without a body.
  app.get('/api/v1/media/:id', requireSessionOrDownloadLink, async (request, response) => {
    const media = (await mediaFor(request.session.user_id, request.params.id));
    if (!media) return response.status(404).json({ error: 'Attachment not found.' });
    // Rows stored before types were preserved hold the generic type; re-derive it from the filename.
    const contentType = resolveContentType(media.contentType, media.filename);
    const inline = Boolean(request.query.inline) && isInlineSafe(contentType);
    response.set({
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition(media.filename, inline ? 'inline' : 'attachment'),
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
    });
    response.sendFile(media.diskName, { root: mediaDirectory, cacheControl: false, dotfiles: 'deny' }, (error) => {
      if (error && !response.headersSent) {
        response.removeHeader('Content-Disposition');
        response.status(404).json({ error: 'Attachment data is no longer available.' });
      }
    });
  });

  app.post('/api/v1/auth/logout', requireSession, async (request, response) => {
    const tokenHash = request.session.token_hash;
    (await db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash));
    for (const socket of websocketServer.clients) {
      if (socket.sessionHash === tokenHash) socket.close(4001, 'Session logged out');
    }
    response.status(204).end();
  });

  app.get('/api/v1/contacts', requireSession, async (request, response) => {
    const rows = (await db.prepare(`SELECT ${USER_COLUMNS.replace(/(^|, )/g, '$1users.')}, contacts.saved AS "saved", contacts.hidden AS "hidden"
      FROM contacts JOIN users ON users.id = contacts.contact_id
      WHERE contacts.owner_id = ? ORDER BY lower(users.username)`)
      .all(request.session.user_id));
    response.json(await Promise.all(rows.map(async (row) => ({
      ...publicUser(row),
      saved: Boolean(row.saved),
      hidden: Boolean(row.hidden),
      disappearSeconds: (await disappearSecondsFor(request.session.user_id, row.id)),
    }))));
  });

  // Clear chat: hide every message for this user only (the other person keeps theirs), optionally keeping some ids.
  app.post('/api/v1/chats/:peerId/clear', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const peerId = request.params.peerId;
    const keepIds = request.body?.keepIds ?? [];
    if (peerId === userId || !(await db.prepare("SELECT 1 FROM users WHERE id = ?").get(peerId))) {
      return response.status(400).json({ error: 'Choose a valid conversation.' });
    }
    if (!Array.isArray(keepIds) || keepIds.length > MAX_CLEAR_KEEP_IDS || keepIds.some((id) => typeof id !== 'string')) {
      return response.status(400).json({ error: `keepIds must be a list of at most ${MAX_CLEAR_KEEP_IDS} message ids.` });
    }
    const hidden = (await hideConversation(userId, peerId, keepIds));
    broadcastUser(userId, { type: 'chat:cleared', peerId, keepIds });
    response.json({ hidden });
  });

  // Delete chat: clear it and drop it from this user's chat list. A saved contact stays in the contact book with the
  // thread hidden; an unsaved link is removed. A later message brings the chat back either way.
  app.post('/api/v1/chats/:peerId/delete', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const peerId = request.params.peerId;
    if (peerId === userId || !(await db.prepare("SELECT 1 FROM users WHERE id = ?").get(peerId))) {
      return response.status(400).json({ error: 'Choose a valid conversation.' });
    }
    const hidden = (await hideConversation(userId, peerId));
    const kept = Boolean((await linkRow.get(userId, peerId))?.saved);
    if (kept) (await db.prepare("UPDATE contacts SET hidden = 1 WHERE owner_id = ? AND contact_id = ?").run(userId, peerId));
    else (await db.prepare("DELETE FROM contacts WHERE owner_id = ? AND contact_id = ?").run(userId, peerId));
    broadcastUser(userId, { type: 'chat:deleted', peerId, kept });
    response.json({ hidden, kept });
  });

  app.get('/api/v1/contacts/search', requireSession, async (request, response) => {
    // Matches handles by prefix and display names by substring, so people are found either way.
    const raw = normalizeDisplayName(request.query.q).slice(0, 40);
    const handle = normalizeUsername(raw.replace(/^@/, '')).replace(/[^a-z0-9_]/g, '');
    if (!raw) return response.json([]);
    const rows = (await db.prepare(`SELECT ${USER_COLUMNS} FROM users
      WHERE id <> ? AND ((length(?) > 0 AND substr(lower(username), 1, length(?)) = lower(?)) OR replace(lower(name), lower(?), '') <> lower(name))
      ORDER BY CASE WHEN substr(lower(username), 1, length(?)) = lower(?) AND length(?) > 0 THEN 0 ELSE 1 END, lower(username) LIMIT 20`)
      .all(request.session.user_id, handle, handle, handle, raw, handle, handle, handle));
    response.json(rows.map(publicUser));
  });

  // Display name: visible everywhere the profile is; the @handle never changes.
  app.patch('/api/v1/me', requireSession, async (request, response) => {
    const error = displayNameError(request.body?.name);
    if (error) return response.status(400).json({ error });
    const name = normalizeDisplayName(request.body.name);
    const userId = request.session.user_id;
    const username = request.session.user.username;
    (await db.prepare("UPDATE users SET name = ?, initials = ? WHERE id = ?").run(name, initialsFor(name, username), userId));
    response.json({ user: (await broadcastProfile(userId)) });
  });

  // Start a chat with someone. `save: false` opens a direct chat without putting them in the contact book;
  // the default saves them. Either way a previously deleted thread comes back.
  app.post('/api/v1/contacts', requireSession, async (request, response) => {
    const contactId = typeof request.body?.userId === 'string' ? request.body.userId : '';
    if (!contactId || contactId === request.session.user_id) {
      return response.status(400).json({ error: 'Choose a different Relay user.' });
    }
    const contact = (await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(contactId));
    if (!contact) return response.status(404).json({ error: 'That Relay handle was not found.' });
    (await linkUsers(request.session.user_id, contactId, { save: request.body?.save !== false }));
    const link = (await linkRow.get(request.session.user_id, contactId));
    response.status(200).json({ ...publicUser(contact), saved: Boolean(link?.saved), hidden: false });
  });

  app.post('/api/v1/pairing', requireSession, async (request, response) => {
    const code = randomBytes(18).toString('base64url');
    (await db.prepare("INSERT INTO pairing_codes(code_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(digest(code), request.session.user_id, Date.now() + PAIRING_TTL_MS));
    response.status(201).json({ code, expiresAt: Date.now() + PAIRING_TTL_MS });
  });

  app.post('/api/v1/pairing/:code/claim', async (request, response) => {
    const code = request.params.code;
    if (typeof code !== 'string' || code.length > 64) return response.status(404).json({ error: 'Pairing code not found.' });
    const row = (await db.prepare("DELETE FROM pairing_codes WHERE code_hash = ? AND expires_at > ? RETURNING user_id")
      .get(digest(code), Date.now()));
    if (!row) return response.status(410).json({ error: 'This pairing code has expired or was already used.' });
    response.json((await issueSession(row.user_id, 'Linked device')));
  });

  app.get('/api/v1/messages', requireSession, async (request, response) => {
    const peerId = String(request.query.peerId ?? '');
    const peer = (await db.prepare("SELECT 1 FROM users WHERE id = ?").get(peerId));
    if (!peer || peerId === request.session.user_id) {
      return response.status(400).json({ error: 'Choose a valid conversation.' });
    }
    (await expireMessages());
    const rows = (await db.prepare(`SELECT id, sender_id AS "senderId", receiver_id AS "receiverId",
      created_at AS "timestamp", content, status, deleted_at IS NOT NULL AS "deleted",
      reply_to_id AS "replyToId", forwarded, expires_at AS "expiresAt" FROM messages
      WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
        AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)
      ORDER BY created_at ASC LIMIT 500`)
      .all(request.session.user_id, peerId, peerId, request.session.user_id, request.session.user_id));
    const reactionRows = (await db.prepare(`SELECT r.message_id AS "messageId", r.user_id AS "userId", r.emoji
      FROM message_reactions r JOIN messages m ON m.id = r.message_id
      WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)`)
      .all(request.session.user_id, peerId, peerId, request.session.user_id));
    const reactionsByMessage = new Map();
    for (const reaction of reactionRows) {
      if (!reactionsByMessage.has(reaction.messageId)) reactionsByMessage.set(reaction.messageId, []);
      reactionsByMessage.get(reaction.messageId).push({ userId: reaction.userId, emoji: reaction.emoji });
    }
    response.json(await Promise.all(rows.map(async (row) => ({
      ...(await presentMessage(row)),
      deleted: Boolean(row.deleted),
      reactions: reactionsByMessage.get(row.id) ?? [],
    }))));
  });

  const socketTasks = new Set();
  function trackSocketTask(task) {
    socketTasks.add(task);
    task.finally(() => socketTasks.delete(task)).catch((error) => {
      console.error('WebSocket task failed:', error.code ?? error.name);
    });
    return task;
  }
  server.on('upgrade', (request, socket, head) => {
    trackSocketTask(authorizeUpgrade(request, socket, head).catch((error) => {
      console.error('WebSocket authorization failed:', error.code ?? error.name);
      if (!socket.destroyed) socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    }));
  });
  async function authorizeUpgrade(request, socket, head) {
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');
    const origin = request.headers.origin;
    if (origin && !originAllowed(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const offered = (request.headers['sec-websocket-protocol'] ?? '').split(',').map((part) => part.trim());
    const authProtocol = offered.find((part) => part.startsWith('relay.auth.'));
    const session = requestUrl.pathname === '/ws' && authProtocol
      ? (await getSession(authProtocol.slice('relay.auth.'.length)))
      : null;
    if (!session || !offered.includes('relay.v1')) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    request.session = session;
    if (socket.destroyed || closing) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      websocketServer.emit('connection', client, request);
    });
  }

  websocketServer.on('connection', (socket, request) => {
    const { user_id: userId, device_id: deviceId } = request.session;
    socket.userId = userId;
    socket.deviceId = deviceId;
    socket.sessionHash = request.session.token_hash;
    socket.backgrounded = false;
    socket.idle = false;
    socket.awaitingPong = false;
    scheduleHeartbeat(socket);
    if (!connections.has(userId)) connections.set(userId, new Set());
    const wasOffline = connections.get(userId).size === 0;
    connections.get(userId).add(socket);
    json(socket, {
      type: 'connection:ready',
      user: request.session.user,
      presence: [...connections.keys()].map((id) => ({ userId: id, status: userSockets(id).size ? 'online' : 'offline' })),
    });
    if (wasOffline) broadcastPresence(userId);

    let queuedBytes = 0;
    let queue = Promise.resolve();
    function enqueue(operation) {
      queue = trackSocketTask(queue.then(operation).catch((error) => {
        console.error('WebSocket operation failed:', error.code ?? error.name);
        json(socket, { type: 'error', message: 'The server could not complete this operation. Please retry.' });
      }));
    }
    enqueue(deliverPendingMessages);
    async function deliverPendingMessages() {
    (await expireMessages());
    const pendingMessages = (await db.prepare(`SELECT messages.id, messages.sender_id AS "senderId",
      messages.receiver_id AS "receiverId", messages.created_at AS "timestamp", messages.content,
      messages.reply_to_id AS "replyToId", messages.forwarded, messages.expires_at AS "expiresAt",
      sender.username AS "senderUsername", sender.name AS "senderName", sender.initials AS "senderInitials",
      sender.color AS "senderColor", receiver.username AS "receiverUsername", receiver.name AS "receiverName",
      receiver.initials AS "receiverInitials", receiver.color AS "receiverColor"
      FROM messages JOIN users AS "sender" ON sender.id = messages.sender_id
      JOIN users AS "receiver" ON receiver.id = messages.receiver_id
      WHERE messages.receiver_id = ? AND messages.status = 'sent' AND messages.deleted_at IS NULL`).all(userId));
    if (pendingMessages.length) {
      (await db.prepare(`UPDATE messages SET status = 'delivered'
        WHERE receiver_id = ? AND status = 'sent'`).run(userId));
      for (const message of pendingMessages) {
        json(socket, { type: 'message:new', message: { ...(await presentMessage(message)), status: 'delivered' } });
        const event = { type: 'message:status', messageId: message.id, status: 'delivered' };
        broadcastUser(message.senderId, event);
        broadcastUser(userId, event, socket);
      }
    }

    }

    socket.on('message', (raw) => {
      const bytes = raw.length;
      if (bytes > 48 * 1024) {
        json(socket, { type: 'error', message: 'Message is too large.' });
        return;
      }
      if (queuedBytes + bytes > 1024 * 1024) {
        socket.close(1008, 'Too many queued messages. Reconnect and retry.');
        return;
      }
      queuedBytes += bytes;
      enqueue(async () => {
        try {
          if (socket.readyState === WebSocket.OPEN) await handleMessage(raw);
        } finally {
          queuedBytes -= bytes;
        }
      });
    });
    async function handleMessage(raw) {
      if (raw.length > 48 * 1024) return;
      let event;
      try { event = JSON.parse(raw.toString()); } catch { return json(socket, { type: 'error', message: 'Invalid message format.' }); }

      if (event.type === 'client:state') {
        socket.backgrounded = event.visibility !== 'visible';
        socket.idle = Boolean(event.idle);
        socket.awaitingPong = false;
        scheduleHeartbeat(socket);
        return;
      }

      if (event.type === 'presence:typing') {
        const peerId = event.peerId;
        if (typeof peerId === 'string' && peerId !== userId && (await db.prepare("SELECT 1 FROM users WHERE id = ?").get(peerId))) {
          broadcastUser(peerId, { type: 'presence:typing', userId, active: Boolean(event.active) });
        }
        return;
      }

      if (event.type === 'call:signal') {
        const { callId, mode, signal } = event;
        let targetId = typeof event.targetId === 'string' ? event.targetId : '';

        // If targetId is a username or handle, resolve it to canonical users.id
        const userByHandle = (await db.prepare("SELECT id FROM users WHERE id = ? OR lower(username) = lower(?)")
          .get(targetId, targetId.replace(/^@/, '')));
        if (userByHandle) {
          targetId = userByHandle.id;
        }

        if (!(await areLinked(userId, targetId)) || targetId === userId || typeof callId !== 'string' || callId.length > 80
          || !['audio', 'video'].includes(mode) || !signal || typeof signal !== 'object'
          || !CALL_SIGNAL_TYPES.has(signal.type)) {
          return json(socket, { type: 'error', message: 'Call signaling is invalid or the user is not a contact.' });
        }

        // Auto-link both sides so each can call and answer; this is a chat link, not a contact-book entry.
        if (signal.type === 'offer') {
          (await linkUsers(userId, targetId));
          (await linkUsers(targetId, userId));
        }

        const serializedSignal = JSON.stringify(signal);
        if (serializedSignal.length > 48 * 1024) return json(socket, { type: 'error', message: 'Call signal is too large.' });
        if (socket.readyState !== WebSocket.OPEN) return;
        const activeCall = activeCalls.get(callId);
        const samePair = activeCall && (
          (activeCall.callerId === userId && activeCall.calleeId === targetId)
          || (activeCall.calleeId === userId && activeCall.callerId === targetId));
        if (activeCall && !samePair) {
          return json(socket, { type: 'error', message: signal.type === 'offer' ? 'Call ID is already in use.' : 'Call signal does not match an active call.' });
        }
        // Another device of a participant must not steer a call owned by a different device.
        if (activeCall) {
          const ownSocket = userId === activeCall.callerId ? activeCall.callerSocket : activeCall.calleeSocket;
          if (ownSocket && ownSocket !== socket) return;
        }
        const initialOffer = signal.type === 'offer' && !activeCall;
        // A pair inside a group call carries the room id, so devices already in that room join without ringing.
        const roomId = typeof event.roomId === 'string' && event.roomId.length <= 80 ? event.roomId : (activeCall?.roomId ?? null);
        if (initialOffer) {
          const call = { callerId: userId, calleeId: targetId, callerSocket: socket, calleeSocket: null, mode, timer: null, roomId };
          if (callTimeoutMs > 0) {
            call.timer = setTimeout(() => finishCall(callId, 'no-answer'), callTimeoutMs);
            call.timer.unref?.();
          }
          activeCalls.set(callId, call);
        }
        if (signal.type === 'answer' && activeCall && !activeCall.calleeSocket && userId === activeCall.calleeId) {
          clearTimeout(activeCall.timer);
          activeCall.timer = null;
          activeCall.calleeSocket = socket;
          const elsewhere = { type: 'call:signal', from: activeCall.callerId, callId, mode: activeCall.mode, signalId: randomUUID(), signal: { type: 'end', reason: 'answered-elsewhere' } };
          broadcastUser(userId, elsewhere, socket);
        }
        if (signal.type === 'end' && activeCall) {
          finishCall(callId, CALL_END_REASONS.has(signal.reason) ? signal.reason : 'ended', socket);
          return;
        }
        const signalId = typeof event.signalId === 'string' ? event.signalId : randomUUID();
        let fromUser = null;
        if (initialOffer) {
          const callerRecord = (await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(userId));
          fromUser = callerRecord ? publicUser(callerRecord) : null;
        }
        const delivered = deliverCallSignal(activeCalls.get(callId), targetId, { type: 'call:signal', from: userId, fromUser, callId, mode, signal, signalId, ...(roomId ? { roomId } : {}) });
        // Only the caller's own socket learns that a callee device is ringing; an offline callee yields no signal.
        if (initialOffer && delivered > 0) {
          json(socket, { type: 'call:signal', from: targetId, callId, mode, signal: { type: 'ringing' }, signalId: randomUUID() });
        }
        return;
      }

      // Group calls: the host invites someone into a room; on accept the newcomer places pair calls
      // (with the room id) to every participant, so no media ever flows through the server.
      if (event.type === 'call:invite' || event.type === 'call:invite-reply') {
        const { roomId, mode } = event;
        let targetId = typeof event.targetId === 'string' ? event.targetId : '';
        const byHandle = (await db.prepare("SELECT id FROM users WHERE id = ? OR lower(username) = lower(?)").get(targetId, targetId.replace(/^@/, '')));
        if (byHandle) targetId = byHandle.id;
        const participants = Array.isArray(event.participants) ? event.participants.filter((id) => typeof id === 'string' && id.length <= 80).slice(0, MAX_CALL_PARTICIPANTS) : [];
        if (typeof roomId !== 'string' || !roomId || roomId.length > 80 || !targetId || targetId === userId || !(await areLinked(userId, targetId))
          || (event.type === 'call:invite' && (!['audio', 'video'].includes(mode) || participants.length >= MAX_CALL_PARTICIPANTS))) {
          return json(socket, { type: 'error', message: 'Call invite is invalid, the user is not a contact, or the call is full.' });
        }
        const record = (await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(userId));
        const fromUser = record ? publicUser(record) : null;
        if (event.type === 'call:invite') {
          // The newcomer will place pair calls to everyone in the room, so each of them must count as a contact.
          for (const participant of new Set([userId, ...participants])) {
            if (participant === targetId || !(await db.prepare("SELECT 1 FROM users WHERE id = ?").get(participant))) continue;
            (await linkUsers(targetId, participant));
            (await linkUsers(participant, targetId));
          }
          const delivered = broadcastUser(targetId, { type: 'call:invite', from: userId, fromUser, roomId, mode, participants: [...new Set([userId, ...participants])] });
          if (delivered === 0) json(socket, { type: 'call:invite-reply', from: targetId, roomId, accepted: false, reason: 'offline' });
          return;
        }
        broadcastUser(targetId, { type: 'call:invite-reply', from: userId, fromUser, roomId, accepted: event.accepted === true, reason: typeof event.reason === 'string' ? event.reason.slice(0, 40) : undefined });
        return;
      }

      if (event.type === 'location:live') {
        const { action, sessionId } = event;
        const peerId = typeof event.peerId === 'string' ? event.peerId : '';
        if (!LIVE_ACTIONS.has(action) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 80
          || !peerId || peerId === userId || !(await areLinked(userId, peerId))) {
          return json(socket, { type: 'error', message: 'Live location request is invalid or the user is not a contact.' });
        }
        const session = liveSessions.get(sessionId);
        if (socket.readyState !== WebSocket.OPEN) return;
        const participant = session && ((session.initiatorId === userId && session.peerId === peerId) || (session.peerId === userId && session.initiatorId === peerId));
        if (action === 'request') {
          const durationMs = Number(event.durationMs);
          if (session || !LIVE_DURATIONS_MS.has(durationMs)) return json(socket, { type: 'error', message: 'Live location duration is not supported.' });
          const startedAt = Date.now();
          const created = { initiatorId: userId, peerId, startedAt, durationMs, accepted: false, timer: null };
          created.timer = setTimeout(() => endLiveSession(sessionId, 'expired'), durationMs);
          created.timer.unref?.();
          liveSessions.set(sessionId, created);
          broadcastUser(peerId, { type: 'location:live', action: 'request', sessionId, from: userId, durationMs, startedAt });
          return;
        }
        if (!participant) return;
        if (action === 'accept') {
          if (session.peerId !== userId) return;
          session.accepted = true;
          broadcastUser(session.initiatorId, { type: 'location:live', action: 'accept', sessionId, from: userId });
          // Other devices of the acceptor learn it was handled elsewhere.
          broadcastUser(userId, { type: 'location:live', action: 'accept', sessionId, from: session.initiatorId }, socket);
          return;
        }
        if (action === 'decline') {
          if (session.peerId !== userId) return;
          endLiveSession(sessionId, 'declined', socket);
          return;
        }
        if (action === 'stop') {
          endLiveSession(sessionId, 'stopped', socket);
          return;
        }
        // action === 'update': positions flow only inside an accepted, unexpired session.
        if (!session.accepted) return;
        const lat = Number(event.lat);
        const lon = Number(event.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
        const accuracy = Number.isFinite(Number(event.accuracy)) ? Math.round(Number(event.accuracy)) : null;
        broadcastUser(peerId, { type: 'location:live', action: 'update', sessionId, from: userId, lat, lon, accuracy, at: Date.now() });
        return;
      }

      if (event.type === 'message:reaction') {
        const { messageId, emoji } = event;
        const row = typeof messageId === 'string'
          ? (await db.prepare("SELECT sender_id, receiver_id FROM messages WHERE id = ? AND deleted_at IS NULL").get(messageId))
          : null;
        const validEmoji = emoji === null || (typeof emoji === 'string' && emoji.length > 0 && emoji.length <= 16);
        if (!row || (row.sender_id !== userId && row.receiver_id !== userId) || !validEmoji) {
          return json(socket, { type: 'message:reaction:error', messageId, message: 'Reaction is invalid.' });
        }
        if (emoji === null) (await db.prepare("DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?").run(messageId, userId));
        else (await db.prepare(`INSERT INTO message_reactions(message_id, user_id, emoji) VALUES (?, ?, ?)
          ON CONFLICT(message_id, user_id) DO UPDATE SET emoji = excluded.emoji`).run(messageId, userId, emoji));
        const reactionEvent = { type: 'message:reaction', messageId, userId, emoji };
        const peerId = row.sender_id === userId ? row.receiver_id : row.sender_id;
        broadcastUser(peerId, reactionEvent);
        broadcastUser(userId, reactionEvent);
        return;
      }

      if (event.type === 'message:delete') {
        const { messageId, scope } = event;
        const row = typeof messageId === 'string'
          ? (await db.prepare("SELECT id, sender_id, receiver_id, created_at, content FROM messages WHERE id = ?").get(messageId))
          : null;
        if (!row || (row.sender_id !== userId && row.receiver_id !== userId)) {
          return json(socket, { type: 'message:delete:error', messageId, message: 'Message not found.' });
        }
        if (scope === 'me') {
          (await db.prepare("INSERT INTO message_hidden(user_id, message_id) VALUES (?, ?) ON CONFLICT DO NOTHING").run(userId, messageId));
          json(socket, { type: 'message:deleted', messageId, scope: 'me' });
          broadcastUser(userId, { type: 'message:deleted', messageId, scope: 'me' }, socket);
          return;
        }
        if (scope !== 'everyone') {
          return json(socket, { type: 'message:delete:error', messageId, message: 'Unknown delete scope.' });
        }
        if (row.sender_id !== userId) {
          return json(socket, { type: 'message:delete:error', messageId, message: 'Only the sender can delete for everyone.' });
        }
        if (Date.now() - row.created_at > deleteForEveryoneWindowMs) {
          return json(socket, { type: 'message:delete:error', messageId, message: 'This message is too old to delete for everyone.' });
        }
        const mediaRef = mediaIdOf(row.content);
        (await db.prepare("UPDATE messages SET content = '', deleted_at = ? WHERE id = ?").run(Date.now(), messageId));
        (await db.prepare("DELETE FROM message_reactions WHERE message_id = ?").run(messageId));
        if (mediaRef && event.deleteMedia !== false) {
          const media = (await db.prepare("SELECT disk_name AS \"diskName\" FROM media WHERE id = ? AND sender_id = ?").get(mediaRef, userId));
          if (media) {
            (await db.prepare("DELETE FROM media WHERE id = ?").run(mediaRef));
            unlink(join(mediaDirectory, media.diskName)).catch(() => {});
          }
        }
        const deletedEvent = { type: 'message:deleted', messageId, scope: 'everyone' };
        broadcastUser(row.receiver_id, deletedEvent);
        broadcastUser(userId, deletedEvent);
        return;
      }

      if (event.type === 'chat:disappearing') {
        const peerId = typeof event.peerId === 'string' ? event.peerId : '';
        const seconds = event.seconds;
        if (!peerId || peerId === userId || !(await db.prepare("SELECT 1 FROM users WHERE id = ?").get(peerId))
          || !(await areLinked(userId, peerId)) || !isDisappearingDuration(seconds)) {
          return json(socket, { type: 'error', message: 'Disappearing messages setting is invalid.' });
        }
        (await db.prepare(`INSERT INTO chat_settings(user_a, user_b, disappear_seconds, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(user_a, user_b) DO UPDATE SET disappear_seconds = excluded.disappear_seconds,
            updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
          .run(...pairOf(userId, peerId), seconds, userId, Date.now()));
        broadcastUser(userId, { type: 'chat:disappearing', peerId, seconds, updatedBy: userId });
        broadcastUser(peerId, { type: 'chat:disappearing', peerId: userId, seconds, updatedBy: userId });
        return;
      }

      if (event.type === 'message:read') {
        const { messageId } = event;
        const result = (await db.prepare(`UPDATE messages SET status = 'read'
          WHERE id = ? AND receiver_id = ? AND status <> 'read'`).run(messageId, userId));
        if (result.changes) {
          const message = (await db.prepare("SELECT sender_id FROM messages WHERE id = ?").get(messageId));
          const statusEvent = { type: 'message:status', messageId, status: 'read' };
          broadcastUser(message.sender_id, statusEvent);
          broadcastUser(userId, statusEvent, socket);
        }
        return;
      }

      if (event.type !== 'message:send') return;
      const payload = event.message ?? {};
      const receiverId = payload.receiverId;
      const content = typeof payload.content === 'string' ? payload.content.trim() : '';
      const mediaId = mediaIdOf(content);
      const receiver = typeof receiverId === 'string' && (await db.prepare("SELECT 1 FROM users WHERE id = ?").get(receiverId));
      // Media from another conversation the sender can read (a forward) is re-shared to this receiver as its own copy.
      const media = mediaId ? (await db.prepare(`SELECT id, sender_id AS "senderId", receiver_id AS "receiverId", filename,
        content_type AS "contentType", byte_size AS "byteSize", disk_name AS "diskName"
        FROM media WHERE id = ? AND (sender_id = ? OR receiver_id = ?)`).get(mediaId, userId, userId)) : null;
      if (!receiver || receiverId === userId || !content || content.length > 4000 || (mediaId && !media)) {
        return json(socket, { type: 'error', message: 'Message is invalid or too long.' });
      }

      const messageId = typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length < 80
        ? payload.id
        : randomUUID();
      const existing = (await db.prepare(`SELECT id, sender_id AS "senderId", receiver_id AS "receiverId",
        created_at AS "timestamp", content, status, reply_to_id AS "replyToId", forwarded, expires_at AS "expiresAt"
        FROM messages WHERE id = ?`).get(messageId));
      if (existing) {
        if (existing.senderId !== userId) return json(socket, { type: 'error', message: 'Message ID is already in use.' });
        return json(socket, { type: 'message:ack', message: (await presentMessage(existing)) });
      }

      const requestedReplyId = typeof payload.replyTo?.id === 'string' ? payload.replyTo.id : null;
      const replyToId = requestedReplyId && (await db.prepare(`SELECT 1 FROM messages WHERE id = ?
        AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))`)
        .get(requestedReplyId, userId, receiverId, receiverId, userId)) ? requestedReplyId : null;

      let storedContent = content;
      if (media && !(media.senderId === userId && media.receiverId === receiverId)) {
        const copyId = randomUUID();
        const diskName = `${copyId}.blob`;
        try {
          try {
            linkSync(join(mediaDirectory, media.diskName), join(mediaDirectory, diskName));
          } catch {
            copyFileSync(join(mediaDirectory, media.diskName), join(mediaDirectory, diskName));
          }
        } catch {
          return json(socket, { type: 'error', message: 'This media is no longer available to forward.' });
        }
        (await db.prepare(`INSERT INTO media(id, sender_id, receiver_id, filename, content_type, byte_size, disk_name, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(copyId, userId, receiverId, media.filename, media.contentType, media.byteSize, diskName, Date.now()));
        const prefixLength = content.indexOf(':') + 1;
        storedContent = `${content.slice(0, prefixLength)}${copyId}${content.slice(prefixLength + mediaId.length)}`;
      }

      const disappearSeconds = (await disappearSecondsFor(userId, receiverId));
      const recipient = (await db.prepare("SELECT username, name, initials, color FROM users WHERE id = ?").get(receiverId));
      const message = {
        id: messageId,
        senderId: userId,
        receiverId,
        senderUsername: request.session.user.username,
        senderName: request.session.user.name,
        senderInitials: request.session.user.initials,
        senderColor: request.session.user.color,
        receiverUsername: recipient.username,
        receiverName: recipient.name,
        receiverInitials: recipient.initials,
        receiverColor: recipient.color,
        timestamp: new Date().toISOString(),
        content: storedContent,
        status: userSockets(receiverId).size ? 'delivered' : 'sent',
        replyToId,
        forwarded: payload.forwarded === true,
        expiresAt: disappearSeconds > 0 ? Date.now() + disappearSeconds * 1000 : null,
      };
      const inserted = (await db.prepare(`INSERT INTO messages(id, sender_id, receiver_id, created_at, content, status, reply_to_id, forwarded, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
        .run(message.id, message.senderId, message.receiverId, message.timestamp, message.content, message.status, replyToId,
          message.forwarded ? 1 : 0, message.expiresAt));
      if (!inserted.changes) {
        const stored = await db.prepare(`SELECT id, sender_id AS "senderId", receiver_id AS "receiverId",
          created_at AS "timestamp", content, status, reply_to_id AS "replyToId", forwarded, expires_at AS "expiresAt"
          FROM messages WHERE id = ?`).get(messageId);
        if (stored.senderId !== userId) return json(socket, { type: 'error', message: 'Message ID is already in use.' });
        return json(socket, { type: 'message:ack', message: await presentMessage(stored) });
      }
      // A message keeps the thread in both chat lists (and brings a deleted thread back) without saving a contact.
      (await linkUsers(userId, receiverId));
      (await linkUsers(receiverId, userId));
      const delivered = (await presentMessage(message));
      broadcastUser(receiverId, { type: 'message:new', message: delivered });
      broadcastUser(userId, { type: 'message:new', message: delivered }, socket);
      json(socket, { type: 'message:ack', message: delivered });
    }

    socket.on('close', () => {
      clearTimeout(socket.heartbeatTimer);
      for (const [callId, activeCall] of activeCalls) {
        if (activeCall.callerSocket === socket || activeCall.calleeSocket === socket) {
          finishCall(callId, 'disconnected', socket);
        }
      }
      const sockets = userSockets(userId);
      sockets.delete(socket);
      if (sockets.size === 0) {
        connections.delete(userId);
        broadcastPresence(userId);
      }
    });
    socket.on('error', () => {});
  });

  websocketServer.on('connection', (socket) => {
    socket.on('pong', () => {
      socket.awaitingPong = false;
      scheduleHeartbeat(socket);
    });
  });

  let expiryTimer;
  let uploadSweep;
  let closing = false;
  let maintenance = Promise.resolve();
  function sweep(operation) {
    maintenance = maintenance.then(operation).catch((error) => {
      console.error('Database maintenance failed:', error.code ?? error.name);
    });
  }
  // Serves the Vite build when present, for hosts without a separate web server in front of the API.
  if (existsSync(join(webDirectory, 'index.html'))) {
    app.use(express.static(webDirectory, { index: 'index.html' }));
    app.get(/^(?!\/api\/|\/ws$)/, (_request, response) => response.sendFile('index.html', { root: webDirectory }));
  }

  app.use((error, request, response, next) => {
    const databaseUnavailable = isDatabaseUnavailable(error);
    // Query errors can echo user data, so only connection-level failures log their message.
    const reason = databaseUnavailable ? (describeDatabaseError(error) ?? error.message) : '';
    console.error(`API request failed: ${request.method} ${request.path} ${error.code ?? error.name}${reason ? ` - ${reason}` : ''}`);
    if (response.headersSent) return next(error);
    if (error.status) return response.status(error.status).json({ error: error.message });
    response.status(503).json({
      error: databaseUnavailable
        ? 'The service is temporarily unavailable. Please retry shortly.'
        : 'The server could not complete this request. Please retry.',
    });
  });

  return {
    app,
    server,
    db,
    expireMessages,
    discardStaleUploads,
    avatarDirectory,
    liveSessions,
    expireLiveSession: (sessionId) => endLiveSession(sessionId, 'expired'),
    // Binds before the database checks: managed hosts (Hostinger) require listen() within seconds of start.
    // A failed check still rejects, after releasing the port, so startup fails instead of serving a broken app.
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      try {
        await db.ready?.();
        await seedDemoUsers();
        await discardStaleUploads();
      } catch (error) {
        await new Promise((resolve) => server.close(resolve));
        throw error;
      }
      expiryTimer = setInterval(() => sweep(expireMessages), EXPIRY_SWEEP_MS);
      expiryTimer.unref();
      uploadSweep = setInterval(() => sweep(discardStaleUploads), 60 * 60 * 1000);
      uploadSweep.unref();
      return server.address();
    },
    async close() {
      closing = true;
      clearInterval(expiryTimer);
      clearInterval(uploadSweep);
      for (const socket of websocketServer.clients) {
        clearTimeout(socket.heartbeatTimer);
        socket.terminate();
      }
      for (const activeCall of activeCalls.values()) clearTimeout(activeCall.timer);
      for (const session of liveSessions.values()) clearTimeout(session.timer);
      liveSessions.clear();
      activeCalls.clear();
      await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...socketTasks]);
      await maintenance;
      await db.close();
    },
  };
}
