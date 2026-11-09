import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { copyFileSync, createWriteStream, existsSync, linkSync, mkdirSync } from 'node:fs';
import { readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createServer } from 'node:http';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
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
import { createEventPilot } from './eventPilot.mjs';
import { pdfPageCountOfFile } from './pdfPages.mjs';
import { canSeePresence, deviceNameFromUserAgent, isLastSeenPrivacy, presenceFor } from './presence.mjs';

const directory = dirname(fileURLToPath(import.meta.url));

// Where uploads (voice notes, photos, documents, profile photos) live. RELAY_DATA_DIRECTORY wins. Without it, a
// deployed server keeps them in the account's home directory: hosting that rebuilds the app from Git on every push
// (Hostinger) replaces the app folder, and files kept inside it were lost on each deploy, so every voice note sent
// before a push turned "unavailable". Development keeps the old .data folder next to the code.
export function defaultDataDirectory(env = process.env, home = homedir()) {
  if (env.RELAY_DATA_DIRECTORY) return env.RELAY_DATA_DIRECTORY;
  const deployed = env.NODE_ENV === 'production' || Boolean(env.DATABASE_URL);
  if (deployed && home) {
    const persistent = resolve(home, 'hidden-messenger-data');
    const inside = relative(resolve(directory, '..'), persistent);
    if (inside.startsWith('..') || isAbsolute(inside)) return persistent;
  }
  return join(directory, '..', '.data');
}
const PAIRING_TTL_MS = 1000 * 60 * 2;
const deleteForEveryoneWindowMs = 24 * 60 * 60 * 1000;
const EXPIRY_SWEEP_MS = 30 * 1000;
// Bounds the request body of a "keep starred" clear; express.json already caps it at 16 kB.
const MAX_CLEAR_KEEP_IDS = 500;
const CALL_END_REASONS = new Set(['ended', 'no-answer', 'disconnected', 'busy', 'failed']);
const CALL_SIGNAL_TYPES = new Set(['offer', 'answer', 'ice', 'end', 'connected', 'ringing', 'media', 'video-request', 'video-accept', 'video-decline', 'video-cancel', 'reaction']);
const CALL_REACTION_EMOJI = new Set(['👍', '❤️', '😂', '😮', '😢', '🙏']);
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
  if (hostname.endsWith('.ngrok-free.dev') || hostname.endsWith('.ngrok.io')
    || (url.protocol === 'https:' && hostname.endsWith('.ngrok-free.app'))) return true;
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
  dataDirectory = defaultDataDirectory(),
  seedDemo = process.env.NODE_ENV !== 'production' && process.env.RELAY_SEED_DEMO === 'true',
  callTimeoutMs = Number(process.env.CALL_RING_TIMEOUT_MS) || 0,
  allowedOrigins = process.env.RELAY_ALLOWED_ORIGINS ?? '',
  webDirectory = join(directory, '..', 'dist'),
  migrate = false,
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
  try {
    mkdirSync(join(dataDirectory, 'media'), { recursive: true });
  } catch (error) {
    // The persistent folder cannot be created here: keep the server running with the folder next to the code
    // (uploads then do not survive a redeploy, which /api/v1/ready reports as storage: release).
    const fallback = join(directory, '..', '.data');
    if (resolve(dataDirectory) === resolve(fallback)) throw error;
    console.error(`Data directory unavailable (${error.code ?? error.name}); using the app folder instead. Set RELAY_DATA_DIRECTORY to a persistent writable path.`);
    dataDirectory = fallback;
    mkdirSync(join(dataDirectory, 'media'), { recursive: true });
  }
  const mediaDirectory = join(dataDirectory, 'media');
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
      receiver_id TEXT,
      group_id TEXT,
      filename TEXT NOT NULL,
      content_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      disk_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      CHECK ((receiver_id IS NULL) <> (group_id IS NULL))
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
  if (!messageColumns.has('played_at')) db.exec('ALTER TABLE messages ADD COLUMN played_at INTEGER');
  // Status updates (24 hours) and who has seen each one.
  db.exec(`CREATE TABLE IF NOT EXISTS statuses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    background TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS statuses_user ON statuses(user_id, expires_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS status_views (
    status_id TEXT NOT NULL,
    viewer_id TEXT NOT NULL,
    viewed_at INTEGER NOT NULL,
    PRIMARY KEY (status_id, viewer_id)
  )`);
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
    receiver_id TEXT,
    group_id TEXT,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    disk_name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((receiver_id IS NULL) <> (group_id IS NULL))
  )`);
  // Attachments gained a group target: older databases rebuild the table so receiver_id may be NULL.
  for (const table of ['media', 'uploads']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.find((column) => column.name === 'receiver_id')?.notnull) continue;
    const names = columns.map((column) => column.name).join(', ');
    const definition = table === 'media'
      ? `id TEXT PRIMARY KEY, sender_id TEXT NOT NULL, receiver_id TEXT, group_id TEXT, filename TEXT NOT NULL, content_type TEXT NOT NULL,
         byte_size INTEGER NOT NULL, disk_name TEXT NOT NULL, created_at INTEGER NOT NULL, CHECK ((receiver_id IS NULL) <> (group_id IS NULL))`
      : `id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, receiver_id TEXT, group_id TEXT, filename TEXT NOT NULL, content_type TEXT NOT NULL,
         byte_size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0, disk_name TEXT NOT NULL, created_at INTEGER NOT NULL,
         updated_at INTEGER NOT NULL, CHECK ((receiver_id IS NULL) <> (group_id IS NULL))`;
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE ${table}_migrated (${definition});
      INSERT INTO ${table}_migrated(${names}) SELECT ${names} FROM ${table};
      DROP TABLE ${table};
      ALTER TABLE ${table}_migrated RENAME TO ${table};
      COMMIT;`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS media_group ON media(group_id) WHERE group_id IS NOT NULL');
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
  db.exec(`CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    auto_delete INTEGER NOT NULL DEFAULT 0 CHECK (auto_delete IN (0, 1)),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS group_members_user ON group_members(user_id, group_id);
  CREATE TABLE IF NOT EXISTS group_messages (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sender_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    content TEXT NOT NULL,
    expires_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS group_messages_history ON group_messages(group_id, created_at, id);
  CREATE INDEX IF NOT EXISTS group_messages_expiry ON group_messages(expires_at) WHERE expires_at IS NOT NULL;
  CREATE TABLE IF NOT EXISTS group_reports (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id),
    reporter_id TEXT NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  const memberColumns = new Set(db.prepare("PRAGMA table_info(group_members)").all().map((column) => column.name));
  if (!memberColumns.has('last_read_at')) db.exec('ALTER TABLE group_members ADD COLUMN last_read_at INTEGER NOT NULL DEFAULT 0');
  if (!memberColumns.has('cleared_at')) db.exec('ALTER TABLE group_members ADD COLUMN cleared_at INTEGER NOT NULL DEFAULT 0');
  const userColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
  if (!userColumns.has('dob')) db.exec('ALTER TABLE users ADD COLUMN dob TEXT');
  if (!userColumns.has('password_hash')) db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
  if (!userColumns.has('avatar_disk_name')) db.exec('ALTER TABLE users ADD COLUMN avatar_disk_name TEXT');
  if (!userColumns.has('avatar_type')) db.exec('ALTER TABLE users ADD COLUMN avatar_type TEXT');
  if (!userColumns.has('avatar_updated_at')) db.exec('ALTER TABLE users ADD COLUMN avatar_updated_at INTEGER');
  if (!userColumns.has('last_seen_at')) db.exec('ALTER TABLE users ADD COLUMN last_seen_at INTEGER');
  if (!userColumns.has('last_seen_privacy')) {
    db.exec("ALTER TABLE users ADD COLUMN last_seen_privacy TEXT NOT NULL DEFAULT 'everyone' CHECK (last_seen_privacy IN ('everyone', 'contacts', 'nobody'))");
  }
  const sessionColumns = new Set(db.prepare("PRAGMA table_info(sessions)").all().map((column) => column.name));
  if (!sessionColumns.has('created_at')) db.exec('ALTER TABLE sessions ADD COLUMN created_at INTEGER');
  if (!sessionColumns.has('last_active_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_active_at INTEGER');
  db.exec(`CREATE TABLE IF NOT EXISTS poll_votes (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    option_index INTEGER NOT NULL CHECK (option_index >= 0 AND option_index < 12),
    voted_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, option_index)
  )`);
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
  async function presentMessage({ replyToId, forwarded, expiresAt, playedAt, ...message }) {
    const quoted = replyToId ? (await quotedMessage.get(replyToId)) : null;
    return {
      ...message,
      ...(quoted ? { replyTo: quoted.deleted ? { id: quoted.id, senderId: quoted.senderId, deleted: true } : { id: quoted.id, senderId: quoted.senderId, content: quoted.content } } : {}),
      ...(forwarded ? { forwarded: true } : {}),
      ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
      // A voice note the recipient has listened to (its mic and waveform turn blue for both people).
      ...(playedAt ? { played: true } : {}),
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

  // View once voice notes are "voice:<mediaId>:<seconds>:once". The recipient gets the audio exactly once, from
  // POST /messages/:id/view-once, which turns the message into "voice-opened:<seconds>" and deletes the audio.
  const VIEW_ONCE_VOICE = /^voice:[^:]+:\d+(?:\.\d+)?:once$/;
  async function isViewOnceMedia(mediaId) {
    return Boolean(await db.prepare('SELECT 1 FROM messages WHERE deleted_at IS NULL AND content LIKE ? LIMIT 1').get(`voice:${mediaId}:%:once`));
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
      await purgeUnreferencedMedia(row.content);
      const event = { type: 'message:deleted', messageId: row.id, scope: 'everyone', reason: 'expired' };
      broadcastUser(row.senderId, event);
      broadcastUser(row.receiverId, event);
    }
    return deleted;
  }

  // Two people may call and signal each other when they are contacts, have chatted, or share a group.
  async function areLinked(left, right) {
    return Boolean((await db.prepare(`SELECT 1 FROM contacts
      WHERE (owner_id = ? AND contact_id = ?) OR (owner_id = ? AND contact_id = ?) LIMIT 1`)
      .get(left, right, right, left))
      || (await db.prepare(`SELECT 1 FROM messages
      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?) LIMIT 1`)
      .get(left, right, right, left))
      || (await db.prepare(`SELECT 1 FROM group_members a JOIN group_members b ON a.group_id = b.group_id
      WHERE a.user_id = ? AND b.user_id = ? LIMIT 1`).get(left, right)));
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

  const eventPilot = createEventPilot();
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
      response.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
      response.set('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-File-Name,X-Upload-Offset,ngrok-skip-browser-warning');
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
    const now = Date.now();
    (await db.prepare(`INSERT INTO sessions(token_hash, user_id, device_id, device_name, expires_at, created_at, last_active_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(digest(token), userId, deviceId, deviceName, null, now, now));
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

  async function runGroupBatch(statements) {
    if (db.dialect === 'postgres') return db.batch(statements);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const { sql, values } of statements) db.prepare(sql).run(...values);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  const groupMembership = db.prepare(`SELECT role, auto_delete AS "autoDelete", last_read_at AS "lastReadAt", cleared_at AS "clearedAt"
    FROM group_members WHERE group_id = ? AND user_id = ?`);
  async function notifyGroup(groupId, event) {
    const members = await db.prepare('SELECT user_id AS "userId" FROM group_members WHERE group_id = ?').all(groupId);
    for (const member of members) broadcastUser(member.userId, event);
  }

  // Removes an attachment's row and file once no stored message (group or direct) references it any more.
  // Every media row owns its own disk file (forwards are hard-linked copies), so this never strands a shared file.
  async function purgeUnreferencedMedia(content) {
    const mediaId = mediaIdOf(content);
    if (!mediaId) return false;
    const exact = [`media:${mediaId}`, `voice:${mediaId}`];
    const prefixed = exact.map((value) => `${value}:%`);
    const referenced = (await db.prepare(`SELECT 1 FROM group_messages
      WHERE content IN (?, ?) OR content LIKE ? OR content LIKE ? LIMIT 1`).get(...exact, ...prefixed))
      || (await db.prepare(`SELECT 1 FROM messages WHERE deleted_at IS NULL AND (content IN (?, ?) OR content LIKE ? OR content LIKE ?) LIMIT 1`)
        .get(...exact, ...prefixed));
    if (referenced) return false;
    if (await db.prepare('SELECT 1 FROM statuses WHERE content IN (?, ?) OR content LIKE ? LIMIT 1').get(exact[0], exact[1], prefixed[0])) return false;
    const media = await db.prepare('DELETE FROM media WHERE id = ? RETURNING disk_name AS "diskName"').get(mediaId);
    if (!media) return false;
    await removeMediaFile(media.diskName);
    return true;
  }

  async function removeMediaFile(diskName) {
    try {
      await unlink(join(mediaDirectory, diskName));
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Attachment file could not be removed (${error.code ?? error.name}); the orphan sweep will retry.`);
    }
  }

  // Hourly safety net: files that no media or upload row names any more, and group attachments that were
  // uploaded but never sent, are removed once they are old enough not to be an upload still in progress.
  async function removeOrphanedMedia(now = Date.now()) {
    const cutoff = now - UPLOAD_STALE_MS;
    const unsent = await db.prepare(`SELECT id, content_type AS "contentType" FROM media WHERE group_id IS NOT NULL AND created_at < ?`).all(cutoff);
    let removed = 0;
    for (const item of unsent) {
      if (await purgeUnreferencedMedia(`media:${item.id}`)) removed += 1;
    }
    const known = new Set([
      ...(await db.prepare('SELECT disk_name AS "diskName" FROM media').all()).map((row) => row.diskName),
      ...(await db.prepare('SELECT disk_name AS "diskName" FROM uploads').all()).map((row) => row.diskName),
    ]);
    for (const entry of await readdir(mediaDirectory)) {
      if (!entry.endsWith('.blob') || known.has(entry)) continue;
      const info = await stat(join(mediaDirectory, entry)).catch(() => null);
      if (!info || info.mtimeMs >= cutoff) continue;
      await removeMediaFile(entry);
      removed += 1;
    }
    return removed;
  }

  // Statuses last 24 hours; their photos and videos go with them.
  async function expireStatuses(now = Date.now()) {
    const rows = await db.prepare('DELETE FROM statuses WHERE expires_at <= ? RETURNING id, content').all(now);
    for (const row of rows) {
      await db.prepare('DELETE FROM status_views WHERE status_id = ?').run(row.id);
      await purgeUnreferencedMedia(row.content);
    }
    return rows.length;
  }

  async function expireGroupMessages(now = Date.now()) {
    const rows = await db.prepare(`DELETE FROM group_messages WHERE expires_at IS NOT NULL AND expires_at <= ?
      RETURNING id, group_id AS "groupId", content`).all(now);
    for (const row of rows) {
      await purgeUnreferencedMedia(row.content);
      await notifyGroup(row.groupId, { type: 'group:message-deleted', groupId: row.groupId, messageId: row.id, reason: 'expired' });
    }
    return rows.length;
  }

  app.get('/api/v1/groups', requireSession, async (request, response) => {
    const now = Date.now();
    const groups = await db.prepare(`SELECT g.id, g.name, g.created_by AS "createdBy", g.created_at AS "createdAt",
      m.role, m.auto_delete AS "autoDelete", latest.content AS "lastContent",
      latest.sender_id AS "lastSenderId", sender.name AS "lastSenderName", latest.created_at AS "lastMessageAt",
      (SELECT count(*) FROM group_messages x WHERE x.group_id = g.id AND x.sender_id <> m.user_id
        AND x.created_at > m.last_read_at AND x.created_at > m.cleared_at AND (x.expires_at IS NULL OR x.expires_at > ?)) AS "unread"
      FROM groups g JOIN group_members m ON m.group_id = g.id
      LEFT JOIN group_messages latest ON latest.id = (
        SELECT id FROM group_messages WHERE group_id = g.id AND created_at > m.cleared_at AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY created_at DESC, id DESC LIMIT 1
      )
      LEFT JOIN users sender ON sender.id = latest.sender_id
      WHERE m.user_id = ? ORDER BY COALESCE(latest.created_at, g.created_at) DESC, g.id`).all(now, now, request.session.user_id);
    response.json(groups.map((group) => ({ ...group, autoDelete: Boolean(group.autoDelete), unread: Number(group.unread) })));
  });

  app.post('/api/v1/groups', requireSession, async (request, response) => {
    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    const members = request.body?.memberIds;
    if (!name || name.length > 100 || !Array.isArray(members) || members.length > 100
      || members.some((id) => typeof id !== 'string' || !id || id.length > 128)) {
      return response.status(400).json({ error: 'Provide a group name and up to 100 valid member IDs.' });
    }
    const userId = request.session.user_id;
    const ids = [...new Set(members.filter((id) => id !== userId))];
    for (const id of ids) {
      if (!await db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return response.status(400).json({ error: 'A selected member does not exist.' });
    }
    const id = randomUUID();
    const now = Date.now();
    await runGroupBatch([
      { sql: 'INSERT INTO groups(id, name, created_by, created_at) VALUES (?, ?, ?, ?)', values: [id, name, userId, now] },
      { sql: 'INSERT INTO group_members(group_id, user_id, role, auto_delete, joined_at) VALUES (?, ?, ?, ?, ?)', values: [id, userId, 'admin', 0, now] },
      ...ids.map((memberId) => ({ sql: 'INSERT INTO group_members(group_id, user_id, role, auto_delete, joined_at) VALUES (?, ?, ?, ?, ?)', values: [id, memberId, 'member', 0, now] })),
    ]);
    await notifyGroup(id, { type: 'group:changed', groupId: id });
    response.status(201).json({ id, name, createdBy: userId, createdAt: now, role: 'admin', autoDelete: false });
  });

  app.get('/api/v1/groups/:groupId', requireSession, async (request, response) => {
    const { groupId } = request.params;
    if (!await groupMembership.get(groupId, request.session.user_id)) return response.status(404).json({ error: 'Group not found.' });
    const group = await db.prepare('SELECT id, name, created_by AS "createdBy", created_at AS "createdAt" FROM groups WHERE id = ?').get(groupId);
    const members = await db.prepare(`SELECT u.id, u.username, u.name, u.initials, u.color, u.avatar_disk_name,
      u.avatar_type, u.avatar_updated_at, m.role, m.joined_at AS "joinedAt" FROM group_members m
      JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.joined_at, u.id`).all(groupId);
    const own = await groupMembership.get(groupId, request.session.user_id);
    response.json({ ...group, role: own.role, autoDelete: Boolean(own.autoDelete), members: members.map((member) => ({ ...publicUser(member), role: member.role, joinedAt: member.joinedAt })) });
  });

  app.post('/api/v1/groups/:groupId/members', requireSession, async (request, response) => {
    const { groupId } = request.params;
    const userId = request.session.user_id;
    const memberId = request.body?.userId;
    if (typeof memberId !== 'string' || !memberId || memberId.length > 128) return response.status(400).json({ error: 'Choose a valid user.' });
    if (!await groupMembership.get(groupId, userId)) return response.status(404).json({ error: 'Group not found.' });
    const inserted = await db.prepare(`INSERT INTO group_members(group_id, user_id, role, auto_delete, joined_at)
      SELECT ?, u.id, 'member', 0, ? FROM users u WHERE u.id = ?
      AND EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND role = 'admin')
      ON CONFLICT(group_id, user_id) DO NOTHING`).run(groupId, Date.now(), memberId, groupId, userId);
    if (!inserted.changes) {
      if ((await groupMembership.get(groupId, userId))?.role !== 'admin') return response.status(403).json({ error: 'Only group admins can add members.' });
      if (!await db.prepare('SELECT 1 FROM users WHERE id = ?').get(memberId)) return response.status(404).json({ error: 'User not found.' });
      return response.status(409).json({ error: 'User is already a group member.' });
    }
    await notifyGroup(groupId, { type: 'group:changed', groupId });
    response.status(201).json({ userId: memberId });
  });

  app.delete('/api/v1/groups/:groupId/membership', requireSession, async (request, response) => {
    const { groupId } = request.params;
    const userId = request.session.user_id;
    const removed = await db.prepare(`DELETE FROM group_members
      WHERE group_id = ? AND user_id = ? AND role = 'member' RETURNING user_id`).get(groupId, userId);
    if (!removed) {
      const membership = await groupMembership.get(groupId, userId);
      if (!membership) return response.status(404).json({ error: 'Group not found.' });
      return response.status(409).json({ error: 'An admin cannot leave until admin transfer is supported.' });
    }
    broadcastUser(userId, { type: 'group:changed', groupId });
    await notifyGroup(groupId, { type: 'group:changed', groupId });
    response.status(204).end();
  });

  app.put('/api/v1/groups/:groupId/member-settings', requireSession, async (request, response) => {
    if (typeof request.body?.autoDelete !== 'boolean') return response.status(400).json({ error: 'autoDelete must be true or false.' });
    const { groupId } = request.params;
    const updated = await db.prepare('UPDATE group_members SET auto_delete = ? WHERE group_id = ? AND user_id = ?')
      .run(request.body.autoDelete ? 1 : 0, groupId, request.session.user_id);
    if (!updated.changes) return response.status(404).json({ error: 'Group not found.' });
    broadcastUser(request.session.user_id, { type: 'group:settings', groupId, autoDelete: request.body.autoDelete });
    response.json({ autoDelete: request.body.autoDelete });
  });

  app.get('/api/v1/groups/:groupId/messages', requireSession, async (request, response) => {
    const { groupId } = request.params;
    const membership = await groupMembership.get(groupId, request.session.user_id);
    if (!membership) return response.status(404).json({ error: 'Group not found.' });
    await expireGroupMessages();
    const messages = await db.prepare(`SELECT * FROM (SELECT id, group_id AS "groupId", sender_id AS "senderId", created_at AS "createdAt",
      content, expires_at AS "expiresAt" FROM group_messages WHERE group_id = ? AND created_at > ? ORDER BY created_at DESC, id DESC LIMIT 500)
      AS recent ORDER BY "createdAt", id`).all(groupId, membership.clearedAt);
    response.json(messages);
  });

  // Marks everything currently in the group as read for this member; the chat list's unread count derives from it.
  app.put('/api/v1/groups/:groupId/read', requireSession, async (request, response) => {
    const { groupId } = request.params;
    const now = Date.now();
    const updated = await db.prepare('UPDATE group_members SET last_read_at = ? WHERE group_id = ? AND user_id = ?').run(now, groupId, request.session.user_id);
    if (!updated.changes) return response.status(404).json({ error: 'Group not found.' });
    broadcastUser(request.session.user_id, { type: 'group:read', groupId, readAt: now });
    response.json({ readAt: now });
  });

  // Clear chat: a member hides the current history from their own view; an admin may clear it for everyone,
  // which permanently removes the messages and any attachments nothing else references.
  app.post('/api/v1/groups/:groupId/clear', requireSession, async (request, response) => {
    const { groupId } = request.params;
    const userId = request.session.user_id;
    const membership = await groupMembership.get(groupId, userId);
    if (!membership) return response.status(404).json({ error: 'Group not found.' });
    const now = Date.now();
    if (request.body?.everyone === true) {
      if (membership.role !== 'admin') return response.status(403).json({ error: 'Only group admins can clear the chat for everyone.' });
      const rows = await db.prepare('DELETE FROM group_messages WHERE group_id = ? RETURNING content').all(groupId);
      for (const row of rows) await purgeUnreferencedMedia(row.content);
      await notifyGroup(groupId, { type: 'group:cleared', groupId, everyone: true, clearedBy: userId });
      return response.json({ cleared: rows.length, everyone: true });
    }
    await db.prepare('UPDATE group_members SET cleared_at = ?, last_read_at = ? WHERE group_id = ? AND user_id = ?').run(now, now, groupId, userId);
    broadcastUser(userId, { type: 'group:cleared', groupId, everyone: false });
    response.json({ clearedAt: now, everyone: false });
  });

  // Reports are stored for the operator to review; they do not change the group for other members.
  app.post('/api/v1/groups/:groupId/report', requireSession, async (request, response) => {
    const { groupId } = request.params;
    const reason = typeof request.body?.reason === 'string' ? request.body.reason.trim() : '';
    if (!reason || reason.length > 500) return response.status(400).json({ error: 'Describe the problem in up to 500 characters.' });
    if (!await groupMembership.get(groupId, request.session.user_id)) return response.status(404).json({ error: 'Group not found.' });
    const id = randomUUID();
    await db.prepare('INSERT INTO group_reports(id, group_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, groupId, request.session.user_id, reason, Date.now());
    response.status(201).json({ id });
  });

  app.post('/api/v1/groups/:groupId/messages', requireSession, async (request, response) => {
    const { groupId } = request.params;
    const userId = request.session.user_id;
    const content = request.body?.content;
    if (typeof content !== 'string' || !content.trim() || content.length > 10000 || content.startsWith('voice:')) {
      return response.status(400).json({ error: 'Provide a text message or an attachment uploaded to this group.' });
    }
    // An attachment must have been uploaded by this sender for this group; nothing from elsewhere can be referenced.
    if (content.startsWith('media:')) {
      const mediaId = mediaIdOf(content);
      const owned = mediaId && await db.prepare('SELECT 1 FROM media WHERE id = ? AND group_id = ? AND sender_id = ?').get(mediaId, groupId, userId);
      if (!owned) return response.status(400).json({ error: 'Upload the attachment to this group first.' });
    }
    const id = randomUUID();
    const now = Date.now();
    const row = await db.prepare(`INSERT INTO group_messages(id, group_id, sender_id, created_at, content, expires_at)
      SELECT ?, group_id, user_id, ?, ?, CASE WHEN auto_delete = 1 THEN CAST(? AS BIGINT) ELSE NULL END
      FROM group_members WHERE group_id = ? AND user_id = ?
      RETURNING id, group_id AS "groupId", sender_id AS "senderId", created_at AS "createdAt", content, expires_at AS "expiresAt"`)
      .get(id, now, content, now + deleteForEveryoneWindowMs, groupId, userId);
    if (!row) return response.status(404).json({ error: 'Group not found.' });
    // The sender has seen their own message; it must not count as unread for them.
    await db.prepare('UPDATE group_members SET last_read_at = ? WHERE group_id = ? AND user_id = ? AND last_read_at < ?').run(now, groupId, userId, now);
    // Names travel with the event so clients can title notifications without another request.
    const names = await db.prepare(`SELECT g.name AS "groupName", u.name AS "senderName" FROM groups g JOIN users u ON u.id = ?
      WHERE g.id = ?`).get(userId, groupId);
    await notifyGroup(groupId, { type: 'group:message', message: row, groupName: names?.groupName ?? null, senderName: names?.senderName ?? null });
    response.status(201).json(row);
  });

  app.delete('/api/v1/groups/:groupId/messages/:messageId', requireSession, async (request, response) => {
    const { groupId, messageId } = request.params;
    const userId = request.session.user_id;
    if (!await groupMembership.get(groupId, userId)) return response.status(404).json({ error: 'Group not found.' });
    const removed = await db.prepare(`DELETE FROM group_messages WHERE id = ? AND group_id = ?
      AND EXISTS (SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?
        AND (role = 'admin' OR (group_messages.sender_id = ? AND group_messages.created_at > ?)))
      RETURNING id, content`).get(messageId, groupId, groupId, userId, userId, Date.now() - deleteForEveryoneWindowMs);
    if (!removed) {
      const message = await db.prepare('SELECT 1 FROM group_messages WHERE id = ? AND group_id = ?').get(messageId, groupId);
      return response.status(message ? 403 : 404).json({ error: message ? 'You cannot delete this message.' : 'Message not found.' });
    }
    await purgeUnreferencedMedia(removed.content);
    await notifyGroup(groupId, { type: 'group:message-deleted', groupId, messageId, reason: 'deleted' });
    response.status(204).end();
  });

  // Presence (online / last seen) honours each owner's "Last seen and online" privacy: every viewer is told
  // only what that setting allows them to see; a hidden owner reads as status 'hidden' with no time.
  const presenceOwner = db.prepare('SELECT id, last_seen_at AS "lastSeenAt", last_seen_privacy AS "privacy" FROM users WHERE id = ?');
  const savedContactIds = db.prepare('SELECT contact_id AS "id" FROM contacts WHERE owner_id = ? AND saved = 1');

  async function presenceViewer(ownerId) {
    const owner = await presenceOwner.get(ownerId);
    if (!owner) return () => null;
    const contactIds = owner.privacy === 'contacts' ? new Set((await savedContactIds.all(ownerId)).map((row) => row.id)) : null;
    const online = isOnline(ownerId);
    return (viewerId) => ({
      userId: ownerId,
      ...presenceFor({ online, lastSeenAt: owner.lastSeenAt, visible: canSeePresence({ ownerId, viewerId, privacy: owner.privacy, ownerContactIds: contactIds }) }),
    });
  }

  // "Online" means the app is open on screen somewhere: a connection that is backgrounded (the app minimised,
  // the screen off) or that only keeps the phone reachable (the Android service's relay.background socket)
  // does not count. Last seen is the moment the last visible connection went away.
  function isOnline(userId) {
    for (const socket of userSockets(userId)) if (!socket.backgrounded) return true;
    return false;
  }

  async function presenceChanged(userId, wasOnline) {
    const online = isOnline(userId);
    if (online === wasOnline) return;
    if (!online) await db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), userId);
    await broadcastPresence(userId);
  }

  async function broadcastPresence(userId) {
    const view = await presenceViewer(userId);
    for (const [viewerId, sockets] of connections) {
      const presence = view(viewerId);
      if (!presence) return;
      for (const socket of sockets) json(socket, { type: 'presence:update', ...presence });
    }
  }

  // Everyone the viewer can see on connect: their chat partners (online or not, for last seen) and anyone online.
  async function presenceSnapshot(viewerId) {
    const partners = (await db.prepare('SELECT contact_id AS "id" FROM contacts WHERE owner_id = ?').all(viewerId)).map((row) => row.id);
    const ids = new Set([...partners, ...connections.keys()]);
    ids.delete(viewerId);
    const views = await Promise.all([...ids].map(async (id) => (await presenceViewer(id))(viewerId)));
    return views.filter(Boolean);
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
  // Whether uploads survive a deploy: files kept inside the deployed release are lost when the next release
  // replaces it (voice notes, photos and documents then show as unavailable). Reported without any path.
  const appRoot = resolve(directory, '..');
  const storageInRelease = (() => {
    const inside = relative(appRoot, resolve(dataDirectory));
    return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
  })();
  if (storageInRelease && process.env.NODE_ENV === 'production') {
    console.error('RELAY_DATA_DIRECTORY is inside the deployed release: uploads will be lost on the next deploy. Point it at a persistent directory such as /var/lib/relay.');
  }

  // Of the newest attachments, how many have lost their file (a health signal; no ids or names are reported).
  async function missingRecentMedia(limit = 50) {
    const rows = await db.prepare('SELECT disk_name AS "diskName" FROM media ORDER BY created_at DESC LIMIT ?').all(limit);
    let missing = 0;
    for (const row of rows) if (!(await stat(join(mediaDirectory, row.diskName)).catch(() => null))) missing += 1;
    return { checked: rows.length, missing };
  }

  app.get('/api/v1/ready', async (_request, response) => {
    response.set('Cache-Control', 'no-store');
    await db.ready?.();
    const recent = await missingRecentMedia().catch(() => null);
    response.json({ status: 'ok', storage: storageInRelease ? 'release' : 'persistent', ...(recent ? { recentMedia: recent } : {}) });
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
    const session = (await issueSession(userId, deviceNameFromUserAgent(request.get('user-agent'))));
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
    response.json((await issueSession(user.id, deviceNameFromUserAgent(request.get('user-agent')))));
  });

  app.get('/api/v1/me', requireSession, (request, response) => {
    const { session } = request;
    response.json({
      user: session.user,
      device: { id: session.device_id, name: session.device_name },
      expiresAt: session.expires_at,
    });
  });

  // --- Account: last-seen privacy, password, and the devices signed in to this account. ---

  function closeSessionSockets(tokenHashes, reason) {
    for (const socket of websocketServer.clients) {
      if (tokenHashes.has(socket.sessionHash)) socket.close(4001, reason);
    }
  }

  app.get('/api/v1/me/privacy', requireSession, async (request, response) => {
    const owner = await presenceOwner.get(request.session.user_id);
    response.json({ lastSeen: owner?.privacy ?? 'everyone' });
  });

  app.put('/api/v1/me/privacy', requireSession, async (request, response) => {
    const lastSeen = request.body?.lastSeen;
    if (!isLastSeenPrivacy(lastSeen)) return response.status(400).json({ error: 'Choose Everyone, My contacts or Nobody.' });
    await db.prepare('UPDATE users SET last_seen_privacy = ? WHERE id = ?').run(lastSeen, request.session.user_id);
    await broadcastPresence(request.session.user_id);
    response.json({ lastSeen });
  });

  // Changing the password signs every other device out; this one stays signed in.
  app.put('/api/v1/me/password', requireSession, async (request, response) => {
    const { currentPassword, newPassword } = request.body ?? {};
    if (typeof newPassword !== 'string' || newPassword.length < 10 || newPassword.length > 128) {
      return response.status(400).json({ error: 'Password must be 10–128 characters.' });
    }
    if (typeof currentPassword !== 'string' || currentPassword.length > 128) {
      return response.status(400).json({ error: 'Enter your current password.' });
    }
    const userId = request.session.user_id;
    const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId);
    if (!row?.password_hash || !(await verifyPassword(currentPassword, row.password_hash))) {
      return response.status(401).json({ error: 'Your current password is incorrect.' });
    }
    if (currentPassword === newPassword) return response.status(400).json({ error: 'Choose a different password.' });
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(newPassword), userId);
    const others = await db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ? RETURNING token_hash AS "hash"')
      .all(userId, request.session.token_hash);
    closeSessionSockets(new Set(others.map((other) => other.hash)), 'Password changed');
    response.json({ signedOutDevices: others.length });
  });

  // Linked devices: each session is a device, identified publicly by its random device id (never the token hash).
  app.get('/api/v1/me/sessions', requireSession, async (request, response) => {
    const rows = await db.prepare(`SELECT token_hash AS "hash", device_id AS "id", device_name AS "deviceName",
      created_at AS "createdAt", last_active_at AS "lastActiveAt"
      FROM sessions WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)`).all(request.session.user_id, Date.now());
    const live = new Set([...websocketServer.clients].map((socket) => socket.sessionHash));
    const devices = rows.map(({ hash, ...device }) => ({ ...device, current: hash === request.session.token_hash, online: live.has(hash) }));
    devices.sort((a, b) => Number(b.current) - Number(a.current) || (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
    response.json(devices);
  });

  app.delete('/api/v1/me/sessions/:deviceId', requireSession, async (request, response) => {
    if (request.params.deviceId === request.session.device_id) {
      return response.status(400).json({ error: 'Use Log out to sign out of this device.' });
    }
    const removed = await db.prepare('DELETE FROM sessions WHERE device_id = ? AND user_id = ? RETURNING token_hash AS "hash"')
      .get(request.params.deviceId, request.session.user_id);
    if (!removed) return response.status(404).json({ error: 'That device is no longer signed in.' });
    closeSessionSockets(new Set([removed.hash]), 'Signed out from another device');
    response.status(204).end();
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

  // An attachment goes to exactly one target: another person (a direct chat) or a group the uploader belongs to.
  async function attachmentTarget(userId, receiverId, groupId) {
    if (groupId) {
      if (receiverId || typeof groupId !== 'string' || groupId.length > 128) return null;
      return (await groupMembership.get(groupId, userId)) ? { receiverId: null, groupId } : null;
    }
    // A status photo or video is uploaded to yourself; contacts can read it only through an active status.
    if (receiverId === userId) return { receiverId: userId, groupId: null };
    if (typeof receiverId !== 'string' || !receiverId) return null;
    return (await db.prepare("SELECT 1 FROM users WHERE id = ?").get(receiverId)) ? { receiverId, groupId: null } : null;
  }

  app.post('/api/v1/media', requireSession, express.raw({ type: () => true, limit: SINGLE_REQUEST_MEDIA_BYTES }), async (request, response) => {
    const target = await attachmentTarget(request.session.user_id, request.query.receiverId, request.query.groupId);
    if (!target) return response.status(400).json({ error: 'Choose a valid conversation.' });
    if (!Buffer.isBuffer(request.body) || request.body.length === 0) return response.status(400).json({ error: 'Choose a non-empty file.' });
    let rawName = String(request.get('x-file-name') ?? 'attachment').slice(0, 1024);
    try { rawName = decodeURIComponent(rawName); } catch { return response.status(400).json({ error: 'Filename encoding is invalid.' }); }
    const filename = sanitizeFilename(rawName);
    const contentType = resolveContentType(request.get('content-type'), filename);
    const id = randomUUID();
    const diskName = `${id}.blob`;
    await writeFile(join(mediaDirectory, diskName), request.body, { flag: 'wx' });
    (await db.prepare(`INSERT INTO media(id, sender_id, receiver_id, group_id, filename, content_type, byte_size, disk_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, request.session.user_id, target.receiverId, target.groupId, filename, contentType, request.body.length, diskName, Date.now()));
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
    const { receiverId, groupId, byteSize } = request.body ?? {};
    const target = await attachmentTarget(request.session.user_id, receiverId, groupId);
    if (!target) return response.status(400).json({ error: 'Choose a valid conversation.' });
    if (!Number.isInteger(byteSize) || byteSize <= 0) return response.status(400).json({ error: 'Choose a non-empty file.' });
    if (byteSize > MAX_MEDIA_BYTES) return response.status(413).json({ error: `Files can be up to ${MAX_MEDIA_BYTES / 1024 ** 3} GB.` });
    const filename = sanitizeFilename(String(request.body?.filename ?? 'attachment').slice(0, 1024));
    const contentType = resolveContentType(request.body?.contentType, filename);
    const id = randomUUID();
    const diskName = `${id}.blob`;
    await writeFile(join(mediaDirectory, diskName), '', { flag: 'wx' });
    const now = Date.now();
    (await db.prepare(`INSERT INTO uploads(id, owner_id, receiver_id, group_id, filename, content_type, byte_size, received, disk_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
      .run(id, request.session.user_id, target.receiverId, target.groupId, filename, contentType, byteSize, diskName, now, now));
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
    (await db.prepare(`INSERT INTO media(id, sender_id, receiver_id, group_id, filename, content_type, byte_size, disk_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(upload.id, upload.owner_id, upload.receiver_id, upload.group_id, upload.filename, upload.content_type, upload.byte_size, upload.disk_name, Date.now()));
    (await db.prepare("DELETE FROM uploads WHERE id = ?").run(upload.id));
    response.status(201).json({ id: upload.id, filename: upload.filename, contentType: upload.content_type, byteSize: upload.byte_size });
  });

  // --- Downloads: a short-lived link lets the browser stream straight to disk (with range resume) without a header. ---

  const downloadLinks = new Map();

  function pruneDownloadLinks(now = Date.now()) {
    for (const [token, link] of downloadLinks) if (link.expiresAt <= now) downloadLinks.delete(token);
  }

  // Direct attachments are readable by both people; group attachments by the group's current members.
  async function mediaFor(userId, mediaId) {
    return (await db.prepare(`SELECT id, filename, content_type AS "contentType", disk_name AS "diskName", byte_size AS "byteSize"
      FROM media WHERE id = ? AND (sender_id = ? OR receiver_id = ?
        OR (group_id IS NOT NULL AND EXISTS (SELECT 1 FROM group_members WHERE group_id = media.group_id AND user_id = ?))
        OR EXISTS (SELECT 1 FROM statuses s JOIN contacts c ON c.owner_id = s.user_id AND c.contact_id = ? AND c.hidden = 0
          WHERE s.user_id = media.sender_id AND s.content LIKE ? AND s.expires_at > ?))`)
      .get(mediaId, userId, userId, userId, userId, `media:${mediaId}:%`, Date.now()));
  }

  // --- Polls: "poll:{question, options[], multiple}" messages in direct or group chats; votes are per option. ---

  function parsePoll(content) {
    if (typeof content !== 'string' || !content.startsWith('poll:')) return null;
    try {
      const poll = JSON.parse(content.slice(5));
      const valid = Array.isArray(poll?.options) && poll.options.length >= 2 && poll.options.length <= 12;
      return valid ? { optionCount: poll.options.length, multiple: poll.multiple === true } : null;
    } catch {
      return null;
    }
  }

  // The poll message plus who should hear about votes, or null when this user cannot see it.
  async function pollFor(userId, messageId) {
    const direct = await db.prepare(`SELECT content, sender_id AS "senderId", receiver_id AS "receiverId" FROM messages
      WHERE id = ? AND deleted_at IS NULL AND (sender_id = ? OR receiver_id = ?)`).get(messageId, userId, userId);
    if (direct) return { poll: parsePoll(direct.content), notify: (event) => { broadcastUser(direct.senderId, event); broadcastUser(direct.receiverId, event); } };
    const group = await db.prepare(`SELECT group_messages.content, group_messages.group_id AS "groupId" FROM group_messages
      JOIN group_members ON group_members.group_id = group_messages.group_id AND group_members.user_id = ?
      WHERE group_messages.id = ?`).get(userId, messageId);
    if (group) return { poll: parsePoll(group.content), notify: (event) => notifyGroup(group.groupId, event) };
    return null;
  }

  async function pollVotes(messageId) {
    const rows = await db.prepare('SELECT user_id AS "userId", option_index AS "option" FROM poll_votes WHERE message_id = ? ORDER BY voted_at, user_id')
      .all(messageId);
    const votes = {};
    for (const { userId, option } of rows) (votes[option] ??= []).push(userId);
    return votes;
  }

  app.get('/api/v1/polls/:messageId', requireSession, async (request, response) => {
    const found = await pollFor(request.session.user_id, request.params.messageId);
    if (!found?.poll) return response.status(404).json({ error: 'Poll not found.' });
    response.json({ messageId: request.params.messageId, votes: await pollVotes(request.params.messageId) });
  });

  // Replaces this user's choice; an empty list withdraws the vote.
  app.put('/api/v1/polls/:messageId/vote', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const { messageId } = request.params;
    const found = await pollFor(userId, messageId);
    if (!found?.poll) return response.status(404).json({ error: 'Poll not found.' });
    const chosen = request.body?.options;
    const options = Array.isArray(chosen) ? [...new Set(chosen)] : null;
    if (!options || options.some((option) => !Number.isInteger(option) || option < 0 || option >= found.poll.optionCount)
      || (!found.poll.multiple && options.length > 1)) {
      return response.status(400).json({ error: found.poll.multiple ? 'Choose valid options.' : 'Choose one option.' });
    }
    const now = Date.now();
    await db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(messageId, userId);
    for (const option of options) {
      await db.prepare('INSERT INTO poll_votes(message_id, user_id, option_index, voted_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING')
        .run(messageId, userId, option, now);
    }
    const votes = await pollVotes(messageId);
    await found.notify({ type: 'poll:votes', messageId, votes });
    response.json({ messageId, votes });
  });

  // The only way to hear a view once voice note: the recipient claims it (atomically, so two devices or a retry
  // cannot both get it), receives the audio in this response, and the file is deleted once it has been sent.
  app.post('/api/v1/messages/:id/view-once', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const row = await db.prepare(`SELECT id, sender_id AS "senderId", receiver_id AS "receiverId", content
      FROM messages WHERE id = ? AND deleted_at IS NULL`).get(request.params.id);
    if (!row || (row.senderId !== userId && row.receiverId !== userId)) return response.status(404).json({ error: 'Message not found.' });
    if (!VIEW_ONCE_VOICE.test(row.content)) return response.status(410).json({ error: 'This voice message was already played.' });
    if (row.receiverId !== userId) return response.status(403).json({ error: 'Only the recipient can play a view once voice message.' });
    const [, mediaId, seconds] = row.content.split(':');
    const opened = `voice-opened:${seconds}`;
    const claimed = await db.prepare('UPDATE messages SET content = ? WHERE id = ? AND content = ? RETURNING id').get(opened, row.id, row.content);
    if (!claimed) return response.status(410).json({ error: 'This voice message was already played.' });
    const media = await db.prepare('SELECT filename, content_type AS "contentType", disk_name AS "diskName" FROM media WHERE id = ?').get(mediaId);
    const event = { type: 'message:updated', messageId: row.id, content: opened };
    broadcastUser(row.senderId, event);
    broadcastUser(row.receiverId, event);
    if (!media) return response.status(410).json({ error: 'This voice message is no longer available.' });
    response.set({
      'Content-Type': resolveContentType(media.contentType, media.filename),
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    response.sendFile(media.diskName, { root: mediaDirectory, cacheControl: false, dotfiles: 'deny' }, (error) => {
      if (error && !response.headersSent) response.status(410).json({ error: 'This voice message is no longer available.' });
      purgeUnreferencedMedia(row.content).catch((failure) => console.error('View once audio could not be removed:', failure.code ?? failure.name));
    });
  });

  app.post('/api/v1/media/:id/link', requireSession, async (request, response) => {
    const media = (await mediaFor(request.session.user_id, request.params.id));
    if (!media) return response.status(404).json({ error: 'Attachment not found.' });
    if (await isViewOnceMedia(media.id)) return response.status(403).json({ error: 'Open view once messages from the chat.' });
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
    if (await isViewOnceMedia(media.id)) return response.status(403).json({ error: 'Open view once messages from the chat.' });
    // Rows stored before types were preserved hold the generic type; re-derive it from the filename.
    const contentType = resolveContentType(media.contentType, media.filename);
    const inline = Boolean(request.query.inline) && isInlineSafe(contentType);
    // "1 page • 0.94 MB • PDF" under a document, like WhatsApp.
    const pages = contentType === 'application/pdf' ? await pdfPageCountOfFile(join(mediaDirectory, media.diskName)) : null;
    if (pages) response.set('X-Page-Count', String(pages));
    response.set({
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition(media.filename, inline ? 'inline' : 'attachment'),
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, X-Page-Count',
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
    closeSessionSockets(new Set([tokenHash]), 'Session logged out');
    response.status(204).end();
  });

  // --- Status: text, photo or video updates that disappear after 24 hours, seen by people in your contacts. ---
  const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
  const STATUS_BACKGROUNDS = new Set(['#00a884', '#128c7e', '#7e57c2', '#ef6c00', '#c2185b', '#1e88e5', '#5d4037', '#37474f']);
  // Everyone who has this author saved or linked: they can see the author's status.
  async function statusAudience(authorId) {
    return (await db.prepare('SELECT contact_id AS "id" FROM contacts WHERE owner_id = ? AND hidden = 0').all(authorId)).map((row) => row.id);
  }
  function presentStatus(row, viewerId) {
    return {
      id: row.id,
      content: row.content,
      ...(row.background ? { background: row.background } : {}),
      createdAt: new Date(Number(row.createdAt)).toISOString(),
      expiresAt: new Date(Number(row.expiresAt)).toISOString(),
      ...(row.userId === viewerId ? { views: Number(row.views) || 0 } : { seen: Boolean(row.seen) }),
    };
  }

  app.get('/api/v1/statuses', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const now = Date.now();
    await expireStatuses(now);
    const rows = await db.prepare(`SELECT s.id, s.user_id AS "userId", s.content, s.background, s.created_at AS "createdAt",
        s.expires_at AS "expiresAt",
        (SELECT count(*) FROM status_views v WHERE v.status_id = s.id) AS "views",
        EXISTS (SELECT 1 FROM status_views v WHERE v.status_id = s.id AND v.viewer_id = ?) AS "seen"
      FROM statuses s
      WHERE s.expires_at > ? AND (s.user_id = ? OR EXISTS (
        SELECT 1 FROM contacts c WHERE c.owner_id = s.user_id AND c.contact_id = ? AND c.hidden = 0))
      ORDER BY s.created_at ASC`).all(userId, now, userId, userId);
    const mine = rows.filter((row) => row.userId === userId).map((row) => presentStatus(row, userId));
    const byAuthor = new Map();
    for (const row of rows.filter((item) => item.userId !== userId)) {
      if (!byAuthor.has(row.userId)) byAuthor.set(row.userId, []);
      byAuthor.get(row.userId).push(presentStatus(row, userId));
    }
    const others = [];
    for (const [authorId, statuses] of byAuthor) {
      const author = await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(authorId);
      if (!author) continue;
      others.push({ user: publicUser(author), statuses, lastAt: statuses.at(-1).createdAt, allSeen: statuses.every((status) => status.seen) });
    }
    others.sort((left, right) => right.lastAt.localeCompare(left.lastAt));
    response.json({ mine, others });
  });

  app.post('/api/v1/statuses', requireSession, express.json({ limit: '16kb' }), async (request, response) => {
    const userId = request.session.user_id;
    const content = typeof request.body?.content === 'string' ? request.body.content.trim() : '';
    const mediaId = content.startsWith('media:') ? mediaIdOf(content) : null;
    if (!content || content.length > (mediaId ? 1200 : 700)) return response.status(400).json({ error: 'A status is up to 700 characters of text, or a photo or video.' });
    if (content.startsWith('voice:')) return response.status(400).json({ error: 'Voice messages cannot be posted as a status.' });
    if (mediaId && !(await db.prepare('SELECT 1 FROM media WHERE id = ? AND sender_id = ?').get(mediaId, userId))) {
      return response.status(400).json({ error: 'Upload the photo or video first.' });
    }
    const background = !mediaId && STATUS_BACKGROUNDS.has(request.body?.background) ? request.body.background : null;
    const now = Date.now();
    const id = randomUUID();
    await db.prepare('INSERT INTO statuses(id, user_id, content, background, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, userId, content, background, now, now + STATUS_TTL_MS);
    const event = { type: 'status:changed', userId };
    for (const viewerId of await statusAudience(userId)) broadcastUser(viewerId, event);
    broadcastUser(userId, event);
    response.status(201).json(presentStatus({ id, userId, content, background, createdAt: now, expiresAt: now + STATUS_TTL_MS, views: 0 }, userId));
  });

  app.post('/api/v1/statuses/:id/view', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const status = await db.prepare(`SELECT s.user_id AS "userId" FROM statuses s
      WHERE s.id = ? AND s.expires_at > ? AND s.user_id <> ? AND EXISTS (
        SELECT 1 FROM contacts c WHERE c.owner_id = s.user_id AND c.contact_id = ? AND c.hidden = 0)`)
      .get(request.params.id, Date.now(), userId, userId);
    if (!status) return response.status(404).json({ error: 'This status is no longer available.' });
    const inserted = await db.prepare('INSERT INTO status_views(status_id, viewer_id, viewed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      .run(request.params.id, userId, Date.now());
    if (inserted.changes) broadcastUser(status.userId, { type: 'status:viewed', statusId: request.params.id, viewerId: userId });
    response.status(204).end();
  });

  app.get('/api/v1/statuses/:id/viewers', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    if (!(await db.prepare('SELECT 1 FROM statuses WHERE id = ? AND user_id = ?').get(request.params.id, userId))) {
      return response.status(404).json({ error: 'Status not found.' });
    }
    const rows = await db.prepare(`SELECT v.viewed_at AS "viewedAt", ${USER_COLUMNS.split(',').map((column) => `u.${column.trim()}`).join(', ')}
      FROM status_views v JOIN users u ON u.id = v.viewer_id WHERE v.status_id = ? ORDER BY v.viewed_at DESC`).all(request.params.id);
    response.json(rows.map((row) => ({ user: publicUser(row), viewedAt: new Date(Number(row.viewedAt)).toISOString() })));
  });

  app.delete('/api/v1/statuses/:id', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const row = await db.prepare('DELETE FROM statuses WHERE id = ? AND user_id = ? RETURNING content').get(request.params.id, userId);
    if (!row) return response.status(404).json({ error: 'Status not found.' });
    await db.prepare('DELETE FROM status_views WHERE status_id = ?').run(request.params.id);
    await purgeUnreferencedMedia(row.content);
    const event = { type: 'status:changed', userId };
    for (const viewerId of await statusAudience(userId)) broadcastUser(viewerId, event);
    broadcastUser(userId, event);
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
      return response.status(400).json({ error: 'Choose a different Hidden Messenger user.' });
    }
    const contact = (await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(contactId));
    if (!contact) return response.status(404).json({ error: 'That Hidden Messenger handle was not found.' });
    (await linkUsers(request.session.user_id, contactId, { save: request.body?.save !== false }));
    // Saving someone can reveal "My contacts" presence to them.
    await broadcastPresence(request.session.user_id);
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
    response.json((await issueSession(row.user_id, deviceNameFromUserAgent(request.get('user-agent'), 'Linked device'))));
  });

  // Catch-up after a dropped connection: every direct message to or from me newer than `after`, plus my own
  // recent messages (their ticks may have moved while I was away). Ordered oldest first, capped at 500.
  app.get('/api/v1/messages/sync', requireSession, async (request, response) => {
    const after = new Date(String(request.query.after ?? ''));
    if (Number.isNaN(after.getTime())) return response.status(400).json({ error: 'Give the time of your newest message as ?after=.' });
    const userId = request.session.user_id;
    (await expireMessages());
    const recentOwn = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await db.prepare(`SELECT id, sender_id AS "senderId", receiver_id AS "receiverId",
      created_at AS "timestamp", content, status, deleted_at IS NOT NULL AS "deleted",
      (deleted_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= deleted_at) AS "expired",
      reply_to_id AS "replyToId", forwarded, expires_at AS "expiresAt", played_at AS "playedAt" FROM messages
      WHERE (sender_id = ? OR receiver_id = ?)
        AND (created_at > ? OR (sender_id = ? AND created_at > ?))
        AND id NOT IN (SELECT message_id FROM message_hidden WHERE user_id = ?)
      ORDER BY created_at ASC LIMIT 500`)
      .all(userId, userId, after.toISOString(), userId, recentOwn, userId);
    response.json(await Promise.all(rows.map(async (row) => ({ ...(await presentMessage(row)), deleted: Boolean(row.deleted), expired: Boolean(row.expired) }))));
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
      (deleted_at IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= deleted_at) AS "expired",
      reply_to_id AS "replyToId", forwarded, expires_at AS "expiresAt", played_at AS "playedAt" FROM messages
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
      expired: Boolean(row.expired),
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
    request.relayBackground = offered.includes('relay.background');
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
    // The Android service's own connection only keeps the phone reachable; it never makes the user "online".
    socket.relayBackground = Boolean(request.relayBackground);
    socket.backgrounded = socket.relayBackground;
    socket.idle = false;
    socket.awaitingPong = false;
    scheduleHeartbeat(socket);
    if (!connections.has(userId)) connections.set(userId, new Set());
    const wasOnline = isOnline(userId);
    connections.get(userId).add(socket);

    let queuedBytes = 0;
    let queue = Promise.resolve();
    function enqueue(operation) {
      queue = trackSocketTask(queue.then(operation).catch((error) => {
        console.error('WebSocket operation failed:', error.code ?? error.name);
        json(socket, { type: 'error', message: 'The server could not complete this operation. Please retry.' });
      }));
    }
    // The first queued task, so "ready" (with the presence the viewer may see) precedes pending messages.
    enqueue(async () => {
      json(socket, { type: 'connection:ready', user: request.session.user, presence: await presenceSnapshot(userId) });
      await db.prepare('UPDATE sessions SET last_active_at = ? WHERE token_hash = ?').run(Date.now(), socket.sessionHash);
      await presenceChanged(userId, wasOnline);
    });
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
    // Re-sent on every connect until the device acknowledges them with message:delivered.
    for (const message of pendingMessages) {
      json(socket, { type: 'message:new', message: { ...(await presentMessage(message)), status: 'sent' } });
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
        const wasOnline = isOnline(userId);
        if (!socket.relayBackground) socket.backgrounded = event.visibility !== 'visible';
        enqueue(() => presenceChanged(userId, wasOnline));
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
          || !CALL_SIGNAL_TYPES.has(signal.type) || (signal.type === 'reaction' && !CALL_REACTION_EMOJI.has(signal.emoji))) {
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
        // The author of the message hears about a new reaction even with the app closed (the background service
        // shows it), so their copy says who reacted and to which message.
        if (emoji && row.sender_id !== userId) {
          const reactor = await db.prepare('SELECT name, username FROM users WHERE id = ?').get(userId);
          const reacted = await db.prepare('SELECT content FROM messages WHERE id = ?').get(messageId);
          broadcastUser(peerId, { ...reactionEvent, messageSenderId: row.sender_id, reactorName: reactor?.name || `@${reactor?.username ?? 'someone'}`, messageContent: String(reacted?.content ?? '').slice(0, 200) });
        } else broadcastUser(peerId, reactionEvent);
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
        // The same attachment can back several messages (a resend to the same person), so the file is only
        // removed once no remaining message references it, and only when this sender uploaded it.
        if (mediaRef && event.deleteMedia !== false
          && (await db.prepare('SELECT 1 FROM media WHERE id = ? AND sender_id = ?').get(mediaRef, userId))) {
          await purgeUnreferencedMedia(row.content);
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

      // The recipient's device confirms it has these messages: one tick becomes two for the sender.
      if (event.type === 'message:delivered') {
        const ids = Array.isArray(event.messageIds) ? event.messageIds.filter((id) => typeof id === 'string' && id.length < 80).slice(0, 200) : [];
        for (const messageId of ids) {
          const updated = await db.prepare(`UPDATE messages SET status = 'delivered'
            WHERE id = ? AND receiver_id = ? AND status = 'sent' RETURNING sender_id AS "senderId"`).get(messageId, userId);
          if (!updated) continue;
          const statusEvent = { type: 'message:status', messageId, status: 'delivered' };
          broadcastUser(updated.senderId, statusEvent);
          broadcastUser(userId, statusEvent, socket);
        }
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

      // The recipient listened to a voice note: it counts as read, and the sender sees the note turn blue.
      if (event.type === 'message:played') {
        const { messageId } = event;
        if (typeof messageId !== 'string' || messageId.length >= 80) return;
        const played = await db.prepare(`UPDATE messages SET played_at = ?, status = 'read'
          WHERE id = ? AND receiver_id = ? AND played_at IS NULL AND deleted_at IS NULL AND content LIKE 'voice:%'
          RETURNING sender_id AS "senderId"`).get(Date.now(), messageId, userId);
        if (!played) return;
        for (const update of [{ type: 'message:status', messageId, status: 'read' }, { type: 'message:played', messageId }]) {
          broadcastUser(played.senderId, update);
          broadcastUser(userId, update, socket);
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
      // View once audio belongs to its one message: it cannot be forwarded or re-sent, and only fresh uploads qualify.
      if (mediaId && await isViewOnceMedia(mediaId)) {
        return json(socket, { type: 'error', message: 'View once messages can’t be forwarded.' });
      }
      if (VIEW_ONCE_VOICE.test(content) && (payload.forwarded === true || media.senderId !== userId || media.receiverId !== receiverId)) {
        return json(socket, { type: 'error', message: 'Only a new voice message can be sent as view once.' });
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
        // One tick until the recipient's device acknowledges it (message:delivered), even if they look online.
        status: 'sent',
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
      const wasOnline = isOnline(userId);
      sockets.delete(socket);
      if (sockets.size === 0) connections.delete(userId);
      trackSocketTask(Promise.resolve(db.prepare('UPDATE sessions SET last_active_at = ? WHERE token_hash = ?').run(Date.now(), socket.sessionHash))
        .then(() => presenceChanged(userId, wasOnline)).catch((error) => {
          console.error('Last seen could not be recorded:', error.code ?? error.name);
        }));
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
  let closePromise;
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
    eventPilot,
    expireMessages,
    expireGroupMessages,
    removeOrphanedMedia,
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
        if (migrate && db.migrate && await db.migrate()) console.log('Created the Hidden Messenger database schema.');
        await db.ready?.();
        await seedDemoUsers();
        await discardStaleUploads();
      } catch (error) {
        await new Promise((resolve) => server.close(resolve));
        throw error;
      }
      expiryTimer = setInterval(() => {
        sweep(expireMessages);
        sweep(expireGroupMessages);
        sweep(expireStatuses);
      }, EXPIRY_SWEEP_MS);
      expiryTimer.unref();
      uploadSweep = setInterval(() => {
        sweep(discardStaleUploads);
        sweep(removeOrphanedMedia);
      }, 60 * 60 * 1000);
      uploadSweep.unref();
      await eventPilot.publish('server:listening', server.address());
      return server.address();
    },
    // Idempotent: callers (and test cleanup hooks) may close more than once; every call awaits the same shutdown.
    close() {
      closePromise ??= (async () => {
        closing = true;
        clearInterval(expiryTimer);
        clearInterval(uploadSweep);
        // Each socket's close handler queues work (e.g. recording last seen); wait for those handlers to run
        // so the tasks are tracked before the database closes.
        const socketsClosed = [];
        for (const socket of websocketServer.clients) {
          clearTimeout(socket.heartbeatTimer);
          socketsClosed.push(new Promise((resolve) => socket.once('close', resolve)));
          socket.terminate();
        }
        await Promise.all(socketsClosed);
        for (const activeCall of activeCalls.values()) clearTimeout(activeCall.timer);
        for (const session of liveSessions.values()) clearTimeout(session.timer);
        liveSessions.clear();
        activeCalls.clear();
        await new Promise((resolve) => server.close(resolve));
        await Promise.allSettled([...socketTasks]);
        await maintenance;
        await eventPilot.publish('server:stopping');
        await eventPilot.close();
        await db.close();
      })();
      return closePromise;
    },
  };
}
