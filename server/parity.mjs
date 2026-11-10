// WhatsApp (Business) feature parity, server side: message edits, account-synced stars, archived chats, pinned
// messages, group administration (roles, permissions, invite links, join approval), communities, the business
// suite (catalog, labels, quick replies, away and greeting messages) and two-step verification.
//
// index.mjs owns sessions, sockets and the message pipeline; this module receives what it needs through `ctx` and
// returns the hooks index.mjs calls at the points where these features change existing behaviour.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import { effectiveRouting, isEnvelope, MAX_DIRECT_ENVELOPE, MAX_GROUP_ENVELOPE, STRUCTURED } from '../src/e2e/envelope.js';

export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const MAX_PINS_PER_CHAT = 3;
export const MAX_LABELS = 20;
export const LABEL_COLORS = 20;
export const MAX_QUICK_REPLIES = 50;
export const MAX_CATALOG_ITEMS = 500;
export const MAX_GROUP_MEMBERS = 1024;
export const MAX_CATALOG_IMAGE_BYTES = 5 * 1024 * 1024;
export const AWAY_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const GREETING_QUIET_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Business hours: { timeZone, days: { "0".."6": [openMinute, closeMinute] } } (0 = Sunday; a missing day is
 * closed). Returns the cleaned value, or null when it is not valid.
 */
export function parseBusinessHours(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || typeof value.timeZone !== 'string') return undefined;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timeZone }); } catch { return undefined; }
  const days = {};
  for (const [day, range] of Object.entries(value.days ?? {})) {
    if (!/^[0-6]$/.test(day) || !Array.isArray(range) || range.length !== 2) return undefined;
    const [open, close] = range.map(Number);
    if (![open, close].every((minute) => Number.isInteger(minute) && minute >= 0 && minute <= 1440) || open >= close) return undefined;
    days[day] = [open, close];
  }
  return { timeZone: value.timeZone, days };
}

/** Whether `at` (ms) falls inside the business hours, in the business's own time zone. */
export function withinBusinessHours(hours, at = Date.now()) {
  if (!hours) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: hours.timeZone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  const day = String(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday));
  const minute = Number(parts.hour) * 60 + Number(parts.minute);
  const range = hours.days[day];
  return Boolean(range) && minute >= range[0] && minute < range[1];
}

// Messages whose content is a structured payload (attachments, calls, polls…) are not edited as text. An
// end-to-end encrypted message is editable when its routing part says it is text (src/e2e/envelope.js).
export function isEditableText(content) {
  if (isEnvelope(content)) return effectiveRouting(content) === 'text';
  return typeof content === 'string' && content.length > 0 && !STRUCTURED.test(content);
}

// A chat as one person sees it: "<peerId>" for a direct chat, "group:<groupId>" for a group.
const CHAT_KEY = /^(?:group:)?[A-Za-z0-9_.-]{1,128}$/;
export function parseChatKey(value) {
  if (typeof value !== 'string' || !CHAT_KEY.test(value)) return null;
  return value.startsWith('group:') ? { kind: 'group', id: value.slice(6), key: value } : { kind: 'direct', id: value, key: value };
}
// Pins are shared by both people of a direct chat, so they are stored under the pair.
export const pairKey = (left, right) => (left < right ? `dm:${left}:${right}` : `dm:${right}:${left}`);

const PIN_PATTERN = /^\d{6}$/;
export const validPin = (value) => typeof value === 'string' && PIN_PATTERN.test(value);
const SHORTCUT_PATTERN = /^[a-z0-9_]{1,25}$/;
const PRICE_PATTERN = /^\d{1,9}(?:\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const INVITE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

function boundedText(value, max, { required = false } = {}) {
  const trimmed = typeof value === 'string' ? value.trim() : null;
  if (trimmed === null) return required ? undefined : '';
  if (required && !trimmed) return undefined;
  return trimmed.length > max ? undefined : trimmed;
}
const bool = (value) => (value ? 1 : 0);

/** SQLite schema (Postgres: supabase/migrations/010_parity.sql). */
export function ensureParitySchema(db) {
  const columns = (table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
  const messages = columns('messages');
  if (!messages.has('edited_at')) db.exec('ALTER TABLE messages ADD COLUMN edited_at INTEGER');
  const groupMessages = columns('group_messages');
  if (!groupMessages.has('edited_at')) db.exec('ALTER TABLE group_messages ADD COLUMN edited_at INTEGER');
  const groups = columns('groups');
  if (!groups.has('description')) db.exec("ALTER TABLE groups ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  if (!groups.has('only_admins_send')) db.exec('ALTER TABLE groups ADD COLUMN only_admins_send INTEGER NOT NULL DEFAULT 0');
  if (!groups.has('only_admins_edit')) db.exec('ALTER TABLE groups ADD COLUMN only_admins_edit INTEGER NOT NULL DEFAULT 0');
  if (!groups.has('approve_joins')) db.exec('ALTER TABLE groups ADD COLUMN approve_joins INTEGER NOT NULL DEFAULT 0');
  if (!groups.has('invite_code')) db.exec('ALTER TABLE groups ADD COLUMN invite_code TEXT');
  if (!groups.has('community_id')) db.exec('ALTER TABLE groups ADD COLUMN community_id TEXT');
  if (!groups.has('is_announcement')) db.exec('ALTER TABLE groups ADD COLUMN is_announcement INTEGER NOT NULL DEFAULT 0');
  const users = columns('users');
  if (!users.has('two_step_hash')) db.exec('ALTER TABLE users ADD COLUMN two_step_hash TEXT');
  if (!users.has('two_step_set_at')) db.exec('ALTER TABLE users ADD COLUMN two_step_set_at INTEGER');
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS groups_invite_code ON groups(invite_code) WHERE invite_code IS NOT NULL;
    CREATE INDEX IF NOT EXISTS groups_community ON groups(community_id) WHERE community_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS group_join_requests (
      group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id),
      requested_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS communities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_by TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      announcement_group_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_stars (
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      chat_key TEXT NOT NULL,
      starred_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, message_id)
    );
    CREATE TABLE IF NOT EXISTS chat_prefs (
      user_id TEXT NOT NULL,
      chat_key TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, chat_key)
    );
    CREATE TABLE IF NOT EXISTS pinned_messages (
      chat_key TEXT NOT NULL,
      message_id TEXT NOT NULL,
      pinned_by TEXT NOT NULL,
      pinned_at INTEGER NOT NULL,
      PRIMARY KEY (chat_key, message_id)
    );
    CREATE TABLE IF NOT EXISTS business_profiles (
      user_id TEXT PRIMARY KEY,
      away_enabled INTEGER NOT NULL DEFAULT 0,
      away_text TEXT NOT NULL DEFAULT '',
      away_schedule TEXT NOT NULL DEFAULT 'always' CHECK (away_schedule IN ('always', 'offline')),
      greeting_enabled INTEGER NOT NULL DEFAULT 0,
      greeting_text TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS business_auto_replies (
      user_id TEXT NOT NULL,
      peer_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('away', 'greeting')),
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, peer_id, kind)
    );
    CREATE TABLE IF NOT EXISTS catalog_items (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price TEXT NOT NULL DEFAULT '',
      currency TEXT NOT NULL DEFAULT '',
      link TEXT NOT NULL DEFAULT '',
      hidden INTEGER NOT NULL DEFAULT 0,
      image_disk_name TEXT,
      image_type TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS catalog_items_user ON catalog_items(user_id, created_at);
    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS labels_user ON labels(user_id);
    CREATE TABLE IF NOT EXISTS label_chats (
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      chat_key TEXT NOT NULL,
      PRIMARY KEY (label_id, chat_key)
    );
    CREATE TABLE IF NOT EXISTS quick_replies (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      shortcut TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (user_id, shortcut)
    );
  `);
  // Business hours for away messages (added after the table exists, also on databases made before them).
  if (!columns('business_profiles').has('away_hours')) db.exec('ALTER TABLE business_profiles ADD COLUMN away_hours TEXT');
}

/**
 * Failed sign-in attempts per account and per address: after 5 failures, each further one waits 30 s, doubling up
 * to 15 minutes. Covers passwords and two-step PINs (a 6-digit PIN is only as strong as its attempt limit).
 */
export function createLoginThrottle({ now = () => Date.now(), freeAttempts = 5, baseMs = 30_000, maxMs = 15 * 60_000 } = {}) {
  const entries = new Map();
  const blockedFor = (key) => {
    const entry = entries.get(key);
    return entry && entry.until > now() ? entry.until - now() : 0;
  };
  return {
    /** Milliseconds the caller must still wait (0 = may try). */
    retryAfter(keys) {
      return Math.max(0, ...keys.map(blockedFor));
    },
    fail(keys) {
      for (const key of keys) {
        const entry = entries.get(key) ?? { failures: 0, until: 0 };
        entry.failures += 1;
        if (entry.failures >= freeAttempts) entry.until = now() + Math.min(maxMs, baseMs * 2 ** (entry.failures - freeAttempts));
        entries.set(key, entry);
      }
      if (entries.size > 50_000) for (const [key, entry] of entries) if (entry.until < now()) entries.delete(key);
    },
    succeed(keys) {
      for (const key of keys) entries.delete(key);
    },
  };
}

export function registerParity(ctx) {
  const { app, db, requireSession, broadcastUser, notifyGroup, groupMembership, publicUser, hashPassword, verifyPassword,
    isOnline, deliverDirectMessage, detectImage, dataDirectory, runBatch, e2e } = ctx;
  const catalogDirectory = join(dataDirectory, 'catalog');
  mkdirSync(catalogDirectory, { recursive: true });
  const now = () => Date.now();

  // --- Shared lookups ---------------------------------------------------------------------------------------
  const userExists = db.prepare('SELECT 1 FROM users WHERE id = ?');
  const groupRow = db.prepare(`SELECT id, name, description, created_by AS "createdBy", only_admins_send AS "onlyAdminsSend",
    only_admins_edit AS "onlyAdminsEdit", approve_joins AS "approveJoins", invite_code AS "inviteCode",
    community_id AS "communityId", is_announcement AS "isAnnouncement" FROM groups WHERE id = ?`);
  const memberCount = db.prepare('SELECT count(*) AS "count" FROM group_members WHERE group_id = ?');
  const adminCount = db.prepare("SELECT count(*) AS \"count\" FROM group_members WHERE group_id = ? AND role = 'admin'");
  const directMessage = db.prepare(`SELECT id, sender_id AS "senderId", receiver_id AS "receiverId", content, created_at AS "timestamp",
    deleted_at AS "deletedAt" FROM messages WHERE id = ?`);
  const groupMessage = db.prepare(`SELECT id, group_id AS "groupId", sender_id AS "senderId", content, created_at AS "createdAt"
    FROM group_messages WHERE id = ?`);

  const flags = (row) => row && ({
    ...row,
    description: row.description ?? '',
    onlyAdminsSend: Number(row.onlyAdminsSend) === 1,
    onlyAdminsEdit: Number(row.onlyAdminsEdit) === 1,
    approveJoins: Number(row.approveJoins) === 1,
    isAnnouncement: Number(row.isAnnouncement) === 1,
  });
  async function groupOf(groupId) {
    return flags(await groupRow.get(groupId));
  }
  async function requireMember(request, response, { admin = false } = {}) {
    const membership = await groupMembership.get(request.params.groupId, request.session.user_id);
    if (!membership) {
      response.status(404).json({ error: 'Group not found.' });
      return null;
    }
    if (admin && membership.role !== 'admin') {
      response.status(403).json({ error: 'Only group admins can do that.' });
      return null;
    }
    return membership;
  }
  const changed = (groupId) => notifyGroup(groupId, { type: 'group:changed', groupId });

  /** Whether a viewer may see a message (direct: a party to it; group: a member). Returns the chat key or null. */
  async function messageChatFor(userId, messageId) {
    const direct = await directMessage.get(messageId);
    if (direct && !direct.deletedAt && (direct.senderId === userId || direct.receiverId === userId)) {
      return { kind: 'direct', key: direct.senderId === userId ? direct.receiverId : direct.senderId, message: direct };
    }
    const group = direct ? null : await groupMessage.get(messageId);
    if (group && await groupMembership.get(group.groupId, userId)) return { kind: 'group', key: `group:${group.groupId}`, groupId: group.groupId, message: group };
    return null;
  }

  // Joining a group of a community also makes you a member of its announcement group (like WhatsApp communities).
  async function addMember(groupId, userId, role = 'member') {
    const inserted = await db.prepare(`INSERT INTO group_members(group_id, user_id, role, auto_delete, joined_at) VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(group_id, user_id) DO NOTHING`).run(groupId, userId, role, now());
    await db.prepare('DELETE FROM group_join_requests WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    if (inserted.changes) await afterMemberAdded(groupId, userId);
    return Boolean(inserted.changes);
  }
  async function afterMemberAdded(groupId, userId) {
    const group = await groupOf(groupId);
    if (!group?.communityId || group.isAnnouncement) return;
    const community = await db.prepare('SELECT announcement_group_id AS "announcementId" FROM communities WHERE id = ?').get(group.communityId);
    if (!community) return;
    const joined = await db.prepare(`INSERT INTO group_members(group_id, user_id, role, auto_delete, joined_at) VALUES (?, ?, 'member', 0, ?)
      ON CONFLICT(group_id, user_id) DO NOTHING`).run(community.announcementId, userId, now());
    if (joined.changes) await changed(community.announcementId);
  }

  // --- Message edits ------------------------------------------------------------------------------------------
  function editError(message, userId, content, maxEnvelope) {
    if (!message) return [404, 'Message not found.'];
    if (message.senderId !== userId) return [403, 'You can only edit your own messages.'];
    if (!isEditableText(message.content)) return [400, 'Only text messages can be edited.'];
    const limit = isEnvelope(content) ? maxEnvelope : 4000;
    if (typeof content !== 'string' || !content.trim() || content.length > limit || !isEditableText(content.trim())) return [400, 'Enter the new text (up to 4,000 characters).'];
    return null;
  }
  const createdMs = (value) => (typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : Date.parse(value));

  app.put('/api/v1/messages/:messageId', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const message = await directMessage.get(request.params.messageId);
    const content = request.body?.content;
    const problem = editError(message && !message.deletedAt ? message : null, userId, content, MAX_DIRECT_ENVELOPE);
    if (problem) return response.status(problem[0]).json({ error: problem[1] });
    if (now() - createdMs(message.timestamp) > EDIT_WINDOW_MS) return response.status(409).json({ error: 'Messages can be edited for 15 minutes after sending.' });
    const sealedProblem = await e2e.checkDirectEnvelope(content.trim(), { senderId: userId, senderDeviceId: request.session.device_id, receiverId: message.receiverId });
    if (sealedProblem) return response.status(sealedProblem.status).json(sealedProblem);
    const editedAt = now();
    await db.prepare('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?').run(content.trim(), editedAt, message.id);
    const event = { type: 'message:edited', messageId: message.id, senderId: message.senderId, content: content.trim(), editedAt: new Date(editedAt).toISOString() };
    broadcastUser(message.senderId, event);
    broadcastUser(message.receiverId, event);
    response.json(event);
  });

  app.put('/api/v1/groups/:groupId/messages/:messageId', requireSession, async (request, response) => {
    if (!await requireMember(request, response)) return;
    const userId = request.session.user_id;
    const message = await groupMessage.get(request.params.messageId);
    const problem = editError(message?.groupId === request.params.groupId ? message : null, userId, request.body?.content, MAX_GROUP_ENVELOPE);
    if (problem) return response.status(problem[0]).json({ error: problem[1] });
    if (now() - createdMs(message.createdAt) > EDIT_WINDOW_MS) return response.status(409).json({ error: 'Messages can be edited for 15 minutes after sending.' });
    const sealedProblem = await e2e.checkGroupEnvelope(request.body.content.trim(), { groupId: message.groupId, senderId: userId, senderDeviceId: request.session.device_id });
    if (sealedProblem) return response.status(sealedProblem.status).json(sealedProblem);
    const editedAt = now();
    const content = request.body.content.trim();
    await db.prepare('UPDATE group_messages SET content = ?, edited_at = ? WHERE id = ?').run(content, editedAt, message.id);
    await notifyGroup(message.groupId, { type: 'group:message-edited', groupId: message.groupId, messageId: message.id, senderId: message.senderId, content, editedAt });
    response.json({ messageId: message.id, content, editedAt });
  });

  // --- Starred messages (follow the account) ------------------------------------------------------------------
  app.get('/api/v1/stars', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const direct = await db.prepare(`SELECT s.message_id AS "messageId", s.chat_key AS "chatKey", s.starred_at AS "starredAt",
      m.content, m.sender_id AS "senderId", m.created_at AS "timestamp", u.name AS "senderName"
      FROM message_stars s JOIN messages m ON m.id = s.message_id AND m.deleted_at IS NULL AND (m.sender_id = s.user_id OR m.receiver_id = s.user_id)
      JOIN users u ON u.id = m.sender_id WHERE s.user_id = ?`).all(userId);
    const group = await db.prepare(`SELECT s.message_id AS "messageId", s.chat_key AS "chatKey", s.starred_at AS "starredAt",
      m.content, m.sender_id AS "senderId", m.created_at AS "createdAt", u.name AS "senderName", g.name AS "groupName", g.id AS "groupId"
      FROM message_stars s JOIN group_messages m ON m.id = s.message_id
      JOIN group_members gm ON gm.group_id = m.group_id AND gm.user_id = s.user_id
      JOIN groups g ON g.id = m.group_id JOIN users u ON u.id = m.sender_id WHERE s.user_id = ?`).all(userId);
    const items = [
      ...direct.map((row) => ({ ...row, starredAt: Number(row.starredAt) })),
      ...group.map(({ createdAt, ...row }) => ({ ...row, starredAt: Number(row.starredAt), timestamp: new Date(Number(createdAt)).toISOString() })),
    ].sort((left, right) => right.starredAt - left.starredAt);
    response.json(items);
  });

  app.put('/api/v1/stars/:messageId', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const chat = await messageChatFor(userId, request.params.messageId);
    if (!chat) return response.status(404).json({ error: 'Message not found.' });
    await db.prepare(`INSERT INTO message_stars(user_id, message_id, chat_key, starred_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, message_id) DO NOTHING`).run(userId, request.params.messageId, chat.key, now());
    broadcastUser(userId, { type: 'stars:changed', messageId: request.params.messageId, starred: true, chatKey: chat.key });
    response.json({ messageId: request.params.messageId, chatKey: chat.key, starred: true });
  });

  app.delete('/api/v1/stars/:messageId', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    await db.prepare('DELETE FROM message_stars WHERE user_id = ? AND message_id = ?').run(userId, request.params.messageId);
    broadcastUser(userId, { type: 'stars:changed', messageId: request.params.messageId, starred: false });
    response.json({ messageId: request.params.messageId, starred: false });
  });

  // --- Archived chats -----------------------------------------------------------------------------------------
  app.get('/api/v1/chat-prefs', requireSession, async (request, response) => {
    const rows = await db.prepare('SELECT chat_key AS "chatKey" FROM chat_prefs WHERE user_id = ? AND archived = 1').all(request.session.user_id);
    response.json({ archived: rows.map((row) => row.chatKey) });
  });

  app.put('/api/v1/chat-prefs/:chatKey', requireSession, async (request, response) => {
    const chat = parseChatKey(request.params.chatKey);
    if (!chat || typeof request.body?.archived !== 'boolean') return response.status(400).json({ error: 'Choose a chat and whether it is archived.' });
    const userId = request.session.user_id;
    await db.prepare(`INSERT INTO chat_prefs(user_id, chat_key, archived, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, chat_key) DO UPDATE SET archived = excluded.archived, updated_at = excluded.updated_at`)
      .run(userId, chat.key, bool(request.body.archived), now());
    broadcastUser(userId, { type: 'chat-prefs:changed', chatKey: chat.key, archived: request.body.archived });
    response.json({ chatKey: chat.key, archived: request.body.archived });
  });

  // --- Pinned messages (shared by everyone in the chat) -------------------------------------------------------
  async function pinScope(userId, chatKey) {
    const chat = parseChatKey(chatKey);
    if (!chat) return null;
    if (chat.kind === 'group') {
      const membership = await groupMembership.get(chat.id, userId);
      if (!membership) return null;
      return { storeKey: chat.key, notify: (event) => notifyGroup(chat.id, event), membership, group: await groupOf(chat.id), chat };
    }
    if (!await userExists.get(chat.id)) return null;
    return { storeKey: pairKey(userId, chat.id), notify: (event) => { broadcastUser(userId, event); broadcastUser(chat.id, event); }, chat };
  }
  // Pins of messages that were deleted or disappeared since are left out (they are not shown or counted).
  const pinList = (storeKey) => db.prepare(`SELECT p.message_id AS "messageId", p.pinned_by AS "pinnedBy", p.pinned_at AS "pinnedAt"
    FROM pinned_messages p WHERE p.chat_key = ?
      AND (EXISTS (SELECT 1 FROM messages m WHERE m.id = p.message_id AND m.deleted_at IS NULL)
        OR EXISTS (SELECT 1 FROM group_messages g WHERE g.id = p.message_id))
    ORDER BY p.pinned_at DESC`).all(storeKey);

  app.get('/api/v1/pins/:chatKey', requireSession, async (request, response) => {
    const scope = await pinScope(request.session.user_id, request.params.chatKey);
    if (!scope) return response.status(404).json({ error: 'Chat not found.' });
    response.json((await pinList(scope.storeKey)).map((row) => ({ ...row, pinnedAt: Number(row.pinnedAt) })));
  });

  app.put('/api/v1/pins/:chatKey/:messageId', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const scope = await pinScope(userId, request.params.chatKey);
    if (!scope) return response.status(404).json({ error: 'Chat not found.' });
    if (scope.group?.onlyAdminsEdit && scope.membership.role !== 'admin') return response.status(403).json({ error: 'Only group admins can pin messages in this group.' });
    const chat = await messageChatFor(userId, request.params.messageId);
    if (!chat || chat.key !== scope.chat.key) return response.status(404).json({ error: 'Message not found in this chat.' });
    await db.prepare(`INSERT INTO pinned_messages(chat_key, message_id, pinned_by, pinned_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_key, message_id) DO UPDATE SET pinned_by = excluded.pinned_by, pinned_at = excluded.pinned_at`)
      .run(scope.storeKey, request.params.messageId, userId, now());
    // Up to three pins: a new one replaces the oldest.
    const pins = await pinList(scope.storeKey);
    for (const extra of pins.slice(MAX_PINS_PER_CHAT)) await db.prepare('DELETE FROM pinned_messages WHERE chat_key = ? AND message_id = ?').run(scope.storeKey, extra.messageId);
    await scope.notify({ type: 'pins:changed', chatKey: scope.chat.kind === 'group' ? scope.chat.key : null, pairOf: scope.chat.kind === 'direct' ? [userId, scope.chat.id] : null });
    response.json({ pinned: true });
  });

  app.delete('/api/v1/pins/:chatKey/:messageId', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const scope = await pinScope(userId, request.params.chatKey);
    if (!scope) return response.status(404).json({ error: 'Chat not found.' });
    if (scope.group?.onlyAdminsEdit && scope.membership.role !== 'admin') return response.status(403).json({ error: 'Only group admins can unpin messages in this group.' });
    await db.prepare('DELETE FROM pinned_messages WHERE chat_key = ? AND message_id = ?').run(scope.storeKey, request.params.messageId);
    await scope.notify({ type: 'pins:changed', chatKey: scope.chat.kind === 'group' ? scope.chat.key : null, pairOf: scope.chat.kind === 'direct' ? [userId, scope.chat.id] : null });
    response.json({ pinned: false });
  });

  // --- Group administration -----------------------------------------------------------------------------------
  /** Extra fields for GET /groups/:id (invite code and pending requests only for admins). */
  async function groupExtras(groupId, role) {
    const group = await groupOf(groupId);
    if (!group) return {};
    const pending = role === 'admin' ? Number((await db.prepare('SELECT count(*) AS "count" FROM group_join_requests WHERE group_id = ?').get(groupId)).count) : 0;
    return {
      description: group.description,
      onlyAdminsSend: group.onlyAdminsSend,
      onlyAdminsEdit: group.onlyAdminsEdit,
      approveJoins: group.approveJoins,
      communityId: group.communityId ?? null,
      isAnnouncement: group.isAnnouncement,
      ...(role === 'admin' ? { inviteCode: group.inviteCode ?? null, pendingRequests: pending } : {}),
    };
  }

  /** Whether this member may post (index.mjs calls this before storing a group message). */
  async function canPostToGroup(groupId, userId) {
    const membership = await groupMembership.get(groupId, userId);
    if (!membership) return { ok: false, status: 404, error: 'Group not found.' };
    const group = await groupOf(groupId);
    if ((group?.onlyAdminsSend || group?.isAnnouncement) && membership.role !== 'admin') return { ok: false, status: 403, error: 'Only admins can send messages to this group.' };
    return { ok: true };
  }

  app.put('/api/v1/groups/:groupId/info', requireSession, async (request, response) => {
    const membership = await requireMember(request, response);
    if (!membership) return;
    const group = await groupOf(request.params.groupId);
    if (group.onlyAdminsEdit && membership.role !== 'admin') return response.status(403).json({ error: 'Only admins can edit this group’s info.' });
    const name = request.body?.name === undefined ? group.name : boundedText(request.body.name, 100, { required: true });
    const description = request.body?.description === undefined ? group.description : boundedText(request.body.description, 2048);
    if (name === undefined || description === undefined) return response.status(400).json({ error: 'A group name is up to 100 characters and a description up to 2,048.' });
    await db.prepare('UPDATE groups SET name = ?, description = ? WHERE id = ?').run(name, description, group.id);
    await changed(group.id);
    response.json({ name, description });
  });

  app.put('/api/v1/groups/:groupId/permissions', requireSession, async (request, response) => {
    if (!await requireMember(request, response, { admin: true })) return;
    const group = await groupOf(request.params.groupId);
    const next = {};
    for (const [field, column] of [['onlyAdminsSend', 'only_admins_send'], ['onlyAdminsEdit', 'only_admins_edit'], ['approveJoins', 'approve_joins']]) {
      if (request.body?.[field] === undefined) continue;
      if (typeof request.body[field] !== 'boolean') return response.status(400).json({ error: `${field} must be true or false.` });
      if (group.isAnnouncement && field === 'onlyAdminsSend' && !request.body[field]) return response.status(409).json({ error: 'Only admins send in a community’s announcement group.' });
      next[column] = request.body[field];
    }
    if (!Object.keys(next).length) return response.status(400).json({ error: 'Nothing to change.' });
    for (const [column, value] of Object.entries(next)) await db.prepare(`UPDATE groups SET ${column} = ? WHERE id = ?`).run(bool(value), group.id);
    await changed(group.id);
    const updated = await groupOf(group.id);
    response.json({ onlyAdminsSend: updated.onlyAdminsSend, onlyAdminsEdit: updated.onlyAdminsEdit, approveJoins: updated.approveJoins });
  });

  app.put('/api/v1/groups/:groupId/members/:memberId/role', requireSession, async (request, response) => {
    if (!await requireMember(request, response, { admin: true })) return;
    const { groupId, memberId } = request.params;
    const role = request.body?.role;
    if (role !== 'admin' && role !== 'member') return response.status(400).json({ error: 'Role is admin or member.' });
    const target = await groupMembership.get(groupId, memberId);
    if (!target) return response.status(404).json({ error: 'That person is not in this group.' });
    const group = await groupOf(groupId);
    if (role === 'member' && memberId === group.createdBy && memberId !== request.session.user_id) return response.status(403).json({ error: 'The group creator can’t be dismissed as admin.' });
    if (role === 'member' && target.role === 'admin' && Number((await adminCount.get(groupId)).count) <= 1) return response.status(409).json({ error: 'A group needs at least one admin.' });
    await db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?').run(role, groupId, memberId);
    await changed(groupId);
    response.json({ userId: memberId, role });
  });

  app.delete('/api/v1/groups/:groupId/members/:memberId', requireSession, async (request, response) => {
    if (!await requireMember(request, response, { admin: true })) return;
    const { groupId, memberId } = request.params;
    if (memberId === request.session.user_id) return response.status(400).json({ error: 'Use “Exit group” to leave.' });
    const group = await groupOf(groupId);
    if (memberId === group.createdBy) return response.status(403).json({ error: 'The group creator can’t be removed.' });
    const removed = await db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, memberId);
    if (!removed.changes) return response.status(404).json({ error: 'That person is not in this group.' });
    broadcastUser(memberId, { type: 'group:changed', groupId });
    await changed(groupId);
    response.status(204).end();
  });

  // Leaving: an admin may leave too; the last admin hands the role to the longest-standing member.
  app.delete('/api/v1/groups/:groupId/membership', requireSession, async (request, response) => {
    const membership = await requireMember(request, response);
    if (!membership) return;
    const { groupId } = request.params;
    const userId = request.session.user_id;
    await db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
    if (membership.role === 'admin' && Number((await adminCount.get(groupId)).count) === 0) {
      const next = await db.prepare('SELECT user_id AS "userId" FROM group_members WHERE group_id = ? ORDER BY joined_at, user_id LIMIT 1').get(groupId);
      if (next) await db.prepare("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?").run(groupId, next.userId);
    }
    broadcastUser(userId, { type: 'group:changed', groupId });
    await changed(groupId);
    response.status(204).end();
  });

  app.post('/api/v1/groups/:groupId/invite', requireSession, async (request, response) => {
    if (!await requireMember(request, response, { admin: true })) return;
    const code = randomBytes(16).toString('base64url');
    await db.prepare('UPDATE groups SET invite_code = ? WHERE id = ?').run(code, request.params.groupId);
    response.status(201).json({ inviteCode: code });
  });

  app.delete('/api/v1/groups/:groupId/invite', requireSession, async (request, response) => {
    if (!await requireMember(request, response, { admin: true })) return;
    await db.prepare('UPDATE groups SET invite_code = NULL WHERE id = ?').run(request.params.groupId);
    response.status(204).end();
  });

  const inviteGroup = (code) => (INVITE_PATTERN.test(code) ? db.prepare('SELECT id FROM groups WHERE invite_code = ?').get(code) : null);

  app.get('/api/v1/invites/:code', requireSession, async (request, response) => {
    const found = await inviteGroup(request.params.code);
    if (!found) return response.status(404).json({ error: 'This invite link was reset or doesn’t exist.' });
    const group = await groupOf(found.id);
    const userId = request.session.user_id;
    response.json({
      groupId: group.id,
      name: group.name,
      description: group.description,
      memberCount: Number((await memberCount.get(group.id)).count),
      approveJoins: group.approveJoins,
      member: Boolean(await groupMembership.get(group.id, userId)),
      requested: Boolean(await db.prepare('SELECT 1 FROM group_join_requests WHERE group_id = ? AND user_id = ?').get(group.id, userId)),
    });
  });

  async function joinOrRequest(groupId, userId, { viaCommunity = false } = {}) {
    const group = await groupOf(groupId);
    if (await groupMembership.get(groupId, userId)) return { status: 200, body: { joined: true, groupId } };
    if (Number((await memberCount.get(groupId)).count) >= MAX_GROUP_MEMBERS) return { status: 409, body: { error: 'This group is full.' } };
    if (group.approveJoins && !viaCommunity) {
      await db.prepare(`INSERT INTO group_join_requests(group_id, user_id, requested_at) VALUES (?, ?, ?)
        ON CONFLICT(group_id, user_id) DO NOTHING`).run(groupId, userId, now());
      const admins = await db.prepare("SELECT user_id AS \"userId\" FROM group_members WHERE group_id = ? AND role = 'admin'").all(groupId);
      for (const admin of admins) broadcastUser(admin.userId, { type: 'group:join-request', groupId });
      return { status: 202, body: { requested: true, groupId } };
    }
    await addMember(groupId, userId);
    broadcastUser(userId, { type: 'group:changed', groupId });
    await changed(groupId);
    return { status: 200, body: { joined: true, groupId } };
  }

  app.post('/api/v1/invites/:code/join', requireSession, async (request, response) => {
    const found = await inviteGroup(request.params.code);
    if (!found) return response.status(404).json({ error: 'This invite link was reset or doesn’t exist.' });
    const result = await joinOrRequest(found.id, request.session.user_id);
    response.status(result.status).json(result.body);
  });

  app.delete('/api/v1/invites/:code/request', requireSession, async (request, response) => {
    const found = await inviteGroup(request.params.code);
    if (found) await db.prepare('DELETE FROM group_join_requests WHERE group_id = ? AND user_id = ?').run(found.id, request.session.user_id);
    response.status(204).end();
  });

  app.get('/api/v1/groups/:groupId/requests', requireSession, async (request, response) => {
    if (!await requireMember(request, response, { admin: true })) return;
    const rows = await db.prepare(`SELECT u.id, u.username, u.name, u.initials, u.color, u.avatar_disk_name, u.avatar_type, u.avatar_updated_at,
      r.requested_at AS "requestedAt" FROM group_join_requests r JOIN users u ON u.id = r.user_id WHERE r.group_id = ? ORDER BY r.requested_at`)
      .all(request.params.groupId);
    response.json(rows.map((row) => ({ ...publicUser(row), requestedAt: Number(row.requestedAt) })));
  });

  app.post('/api/v1/groups/:groupId/requests/:requesterId', requireSession, async (request, response) => {
    if (!await requireMember(request, response, { admin: true })) return;
    const { groupId, requesterId } = request.params;
    if (typeof request.body?.approve !== 'boolean') return response.status(400).json({ error: 'Approve or reject the request.' });
    const pending = await db.prepare('SELECT 1 FROM group_join_requests WHERE group_id = ? AND user_id = ?').get(groupId, requesterId);
    if (!pending) return response.status(404).json({ error: 'No pending request from this person.' });
    if (request.body.approve) {
      await addMember(groupId, requesterId);
      broadcastUser(requesterId, { type: 'group:changed', groupId });
    } else {
      await db.prepare('DELETE FROM group_join_requests WHERE group_id = ? AND user_id = ?').run(groupId, requesterId);
    }
    await changed(groupId);
    response.json({ userId: requesterId, approved: request.body.approve });
  });

  // --- Communities --------------------------------------------------------------------------------------------
  const communityRow = db.prepare(`SELECT id, name, description, created_by AS "createdBy", created_at AS "createdAt",
    announcement_group_id AS "announcementGroupId" FROM communities WHERE id = ?`);
  async function communityView(communityId, userId) {
    const community = await communityRow.get(communityId);
    if (!community) return null;
    const groups = await db.prepare(`SELECT g.id, g.name, g.description, g.is_announcement AS "isAnnouncement", g.approve_joins AS "approveJoins",
      (SELECT count(*) FROM group_members x WHERE x.group_id = g.id) AS "memberCount",
      (SELECT role FROM group_members y WHERE y.group_id = g.id AND y.user_id = ?) AS "role",
      (SELECT 1 FROM group_join_requests r WHERE r.group_id = g.id AND r.user_id = ?) AS "requested"
      FROM groups g WHERE g.community_id = ? ORDER BY g.is_announcement DESC, g.name`).all(userId, userId, communityId);
    const announcementRole = groups.find((group) => group.id === community.announcementGroupId)?.role ?? null;
    const isMember = groups.some((group) => group.role);
    if (!isMember) return null;
    return {
      ...community,
      createdAt: Number(community.createdAt),
      role: announcementRole === 'admin' ? 'admin' : 'member',
      groups: groups.map((group) => ({
        id: group.id, name: group.name, description: group.description ?? '',
        isAnnouncement: Number(group.isAnnouncement) === 1, approveJoins: Number(group.approveJoins) === 1,
        memberCount: Number(group.memberCount), role: group.role ?? null, requested: Boolean(group.requested),
      })),
    };
  }
  async function requireCommunityAdmin(request, response) {
    const view = await communityView(request.params.communityId, request.session.user_id);
    if (!view) {
      response.status(404).json({ error: 'Community not found.' });
      return null;
    }
    if (view.role !== 'admin') {
      response.status(403).json({ error: 'Only community admins can do that.' });
      return null;
    }
    return view;
  }
  async function notifyCommunity(communityId) {
    const members = await db.prepare(`SELECT DISTINCT m.user_id AS "userId" FROM group_members m JOIN groups g ON g.id = m.group_id
      WHERE g.community_id = ?`).all(communityId);
    for (const member of members) broadcastUser(member.userId, { type: 'community:changed', communityId });
  }
  async function linkGroup(communityId, groupId) {
    await db.prepare('UPDATE groups SET community_id = ? WHERE id = ?').run(communityId, groupId);
    const members = await db.prepare('SELECT user_id AS "userId" FROM group_members WHERE group_id = ?').all(groupId);
    for (const member of members) await afterMemberAdded(groupId, member.userId);
  }

  app.get('/api/v1/communities', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const rows = await db.prepare(`SELECT DISTINCT g.community_id AS "id" FROM groups g JOIN group_members m ON m.group_id = g.id
      WHERE m.user_id = ? AND g.community_id IS NOT NULL`).all(userId);
    const views = (await Promise.all(rows.map((row) => communityView(row.id, userId)))).filter(Boolean);
    response.json(views.sort((left, right) => left.name.localeCompare(right.name)));
  });

  app.post('/api/v1/communities', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const name = boundedText(request.body?.name, 100, { required: true });
    const description = boundedText(request.body?.description, 2048);
    const groupIds = request.body?.groupIds ?? [];
    if (name === undefined || description === undefined || !Array.isArray(groupIds) || groupIds.length > 50 || groupIds.some((id) => typeof id !== 'string')) {
      return response.status(400).json({ error: 'A community needs a name (up to 100 characters) and up to 50 groups.' });
    }
    for (const groupId of groupIds) {
      const membership = await groupMembership.get(groupId, userId);
      const group = await groupOf(groupId);
      if (membership?.role !== 'admin' || !group) return response.status(403).json({ error: 'You can only add groups you’re an admin of.' });
      if (group.communityId) return response.status(409).json({ error: `“${group.name}” is already in a community.` });
    }
    const id = randomUUID();
    const announcementId = randomUUID();
    const at = now();
    await runBatch([
      { sql: `INSERT INTO groups(id, name, created_by, created_at, description, only_admins_send, only_admins_edit, community_id, is_announcement)
        VALUES (?, ?, ?, ?, ?, 1, 1, ?, 1)`, values: [announcementId, name, userId, at, description, id] },
      { sql: 'INSERT INTO group_members(group_id, user_id, role, auto_delete, joined_at) VALUES (?, ?, ?, 0, ?)', values: [announcementId, userId, 'admin', at] },
      { sql: 'INSERT INTO communities(id, name, description, created_by, created_at, announcement_group_id) VALUES (?, ?, ?, ?, ?, ?)', values: [id, name, description, userId, at, announcementId] },
    ]);
    for (const groupId of groupIds) await linkGroup(id, groupId);
    await notifyCommunity(id);
    broadcastUser(userId, { type: 'group:changed', groupId: announcementId });
    response.status(201).json(await communityView(id, userId));
  });

  app.get('/api/v1/communities/:communityId', requireSession, async (request, response) => {
    const view = await communityView(request.params.communityId, request.session.user_id);
    if (!view) return response.status(404).json({ error: 'Community not found.' });
    response.json(view);
  });

  app.put('/api/v1/communities/:communityId', requireSession, async (request, response) => {
    const view = await requireCommunityAdmin(request, response);
    if (!view) return;
    const name = request.body?.name === undefined ? view.name : boundedText(request.body.name, 100, { required: true });
    const description = request.body?.description === undefined ? view.description : boundedText(request.body.description, 2048);
    if (name === undefined || description === undefined) return response.status(400).json({ error: 'A community name is up to 100 characters and a description up to 2,048.' });
    await db.prepare('UPDATE communities SET name = ?, description = ? WHERE id = ?').run(name, description, view.id);
    await db.prepare('UPDATE groups SET name = ?, description = ? WHERE id = ?').run(name, description, view.announcementGroupId);
    await notifyCommunity(view.id);
    await changed(view.announcementGroupId);
    response.json(await communityView(view.id, request.session.user_id));
  });

  // Adds an existing group (you must be its admin) or creates a new one inside the community.
  app.post('/api/v1/communities/:communityId/groups', requireSession, async (request, response) => {
    const view = await requireCommunityAdmin(request, response);
    if (!view) return;
    const userId = request.session.user_id;
    let groupId = request.body?.groupId;
    if (typeof groupId === 'string') {
      const group = await groupOf(groupId);
      if ((await groupMembership.get(groupId, userId))?.role !== 'admin' || !group) return response.status(403).json({ error: 'You can only add groups you’re an admin of.' });
      if (group.communityId) return response.status(409).json({ error: 'That group is already in a community.' });
    } else {
      const name = boundedText(request.body?.name, 100, { required: true });
      if (name === undefined) return response.status(400).json({ error: 'Give the new group a name (up to 100 characters).' });
      groupId = randomUUID();
      const at = now();
      await runBatch([
        { sql: 'INSERT INTO groups(id, name, created_by, created_at) VALUES (?, ?, ?, ?)', values: [groupId, name, userId, at] },
        { sql: 'INSERT INTO group_members(group_id, user_id, role, auto_delete, joined_at) VALUES (?, ?, ?, 0, ?)', values: [groupId, userId, 'admin', at] },
      ]);
    }
    await linkGroup(view.id, groupId);
    await notifyCommunity(view.id);
    await changed(groupId);
    response.status(201).json(await communityView(view.id, userId));
  });

  app.delete('/api/v1/communities/:communityId/groups/:groupId', requireSession, async (request, response) => {
    const view = await requireCommunityAdmin(request, response);
    if (!view) return;
    const { groupId } = request.params;
    if (groupId === view.announcementGroupId) return response.status(409).json({ error: 'The announcement group belongs to the community.' });
    const unlinked = await db.prepare('UPDATE groups SET community_id = NULL WHERE id = ? AND community_id = ?').run(groupId, view.id);
    if (!unlinked.changes) return response.status(404).json({ error: 'That group isn’t in this community.' });
    await notifyCommunity(view.id);
    await changed(groupId);
    response.json(await communityView(view.id, request.session.user_id));
  });

  // Community members can join its groups (or ask to, when the group approves new members).
  app.post('/api/v1/communities/:communityId/groups/:groupId/join', requireSession, async (request, response) => {
    const view = await communityView(request.params.communityId, request.session.user_id);
    if (!view) return response.status(404).json({ error: 'Community not found.' });
    const group = view.groups.find((item) => item.id === request.params.groupId);
    if (!group) return response.status(404).json({ error: 'That group isn’t in this community.' });
    const result = await joinOrRequest(group.id, request.session.user_id, { viaCommunity: !group.approveJoins });
    response.status(result.status).json(result.body);
  });

  app.delete('/api/v1/communities/:communityId', requireSession, async (request, response) => {
    const view = await requireCommunityAdmin(request, response);
    if (!view) return;
    const members = await db.prepare(`SELECT DISTINCT m.user_id AS "userId" FROM group_members m JOIN groups g ON g.id = m.group_id
      WHERE g.community_id = ?`).all(view.id);
    await db.prepare('UPDATE groups SET community_id = NULL, is_announcement = 0 WHERE community_id = ?').run(view.id);
    await db.prepare('DELETE FROM communities WHERE id = ?').run(view.id);
    for (const member of members) {
      broadcastUser(member.userId, { type: 'community:changed', communityId: view.id });
      broadcastUser(member.userId, { type: 'group:changed', groupId: view.announcementGroupId });
    }
    response.status(204).end();
  });

  // --- Business: catalog --------------------------------------------------------------------------------------
  const catalogColumns = `id, user_id AS "userId", name, description, price, currency, link, hidden, image_disk_name AS "imageDiskName",
    created_at AS "createdAt", updated_at AS "updatedAt"`;
  const presentItem = (row) => ({
    id: row.id, userId: row.userId, name: row.name, description: row.description, price: row.price, currency: row.currency, link: row.link,
    hidden: Number(row.hidden) === 1,
    image: row.imageDiskName ? `/api/v1/catalog/${encodeURIComponent(row.id)}/image?v=${Number(row.updatedAt)}` : null,
    createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
  });
  function parseItem(body, current = {}) {
    const pick = (field, parse) => (body?.[field] === undefined ? current[field] ?? (field === 'hidden' ? false : '') : parse(body[field]));
    const name = pick('name', (value) => boundedText(value, 120, { required: true }));
    const description = pick('description', (value) => boundedText(value, 2000));
    const price = pick('price', (value) => { const v = boundedText(value, 13); return v === '' || PRICE_PATTERN.test(v ?? '') ? v : undefined; });
    const currency = pick('currency', (value) => { const v = boundedText(value, 3)?.toUpperCase(); return v === '' || CURRENCY_PATTERN.test(v ?? '') ? v : undefined; });
    const link = pick('link', (value) => { const v = boundedText(value, 500); return v === '' || /^https:\/\/\S+$/.test(v ?? '') ? v : undefined; });
    const hidden = pick('hidden', (value) => (typeof value === 'boolean' ? value : undefined));
    if ([name, description, price, currency, link, hidden].includes(undefined)) return null;
    if (price && !currency) return null;
    return { name, description, price, currency: price ? currency : '', link, hidden };
  }
  const itemRow = db.prepare(`SELECT ${catalogColumns} FROM catalog_items WHERE id = ?`);

  app.get('/api/v1/users/:userId/catalog', requireSession, async (request, response) => {
    const own = request.params.userId === request.session.user_id;
    const rows = await db.prepare(`SELECT ${catalogColumns} FROM catalog_items WHERE user_id = ? ${own ? '' : 'AND hidden = 0'} ORDER BY created_at DESC`)
      .all(request.params.userId);
    response.json(rows.map(presentItem));
  });

  app.get('/api/v1/catalog/:itemId', requireSession, async (request, response) => {
    const row = await itemRow.get(request.params.itemId);
    if (!row || (Number(row.hidden) === 1 && row.userId !== request.session.user_id)) return response.status(404).json({ error: 'This item is no longer available.' });
    const owner = await db.prepare('SELECT id, username, name, initials, color, avatar_disk_name, avatar_type, avatar_updated_at FROM users WHERE id = ?').get(row.userId);
    response.json({ ...presentItem(row), owner: owner ? publicUser(owner) : null });
  });

  app.post('/api/v1/catalog', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const item = parseItem(request.body);
    if (!item) return response.status(400).json({ error: 'An item needs a name (up to 120 characters); a price needs a 3-letter currency; links start with https://.' });
    if (Number((await db.prepare('SELECT count(*) AS "count" FROM catalog_items WHERE user_id = ?').get(userId)).count) >= MAX_CATALOG_ITEMS) {
      return response.status(409).json({ error: 'A catalog holds up to 500 items.' });
    }
    const id = randomUUID();
    const at = now();
    await db.prepare(`INSERT INTO catalog_items(id, user_id, name, description, price, currency, link, hidden, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, item.name, item.description, item.price, item.currency, item.link, bool(item.hidden), at, at);
    response.status(201).json(presentItem(await itemRow.get(id)));
  });

  async function ownItem(request, response) {
    const row = await itemRow.get(request.params.itemId);
    if (!row || row.userId !== request.session.user_id) {
      response.status(404).json({ error: 'Item not found.' });
      return null;
    }
    return row;
  }

  app.put('/api/v1/catalog/:itemId', requireSession, async (request, response) => {
    const row = await ownItem(request, response);
    if (!row) return;
    const item = parseItem(request.body, { ...row, hidden: Number(row.hidden) === 1 });
    if (!item) return response.status(400).json({ error: 'Check the name, price, currency and link.' });
    await db.prepare(`UPDATE catalog_items SET name = ?, description = ?, price = ?, currency = ?, link = ?, hidden = ?, updated_at = ? WHERE id = ?`)
      .run(item.name, item.description, item.price, item.currency, item.link, bool(item.hidden), now(), row.id);
    response.json(presentItem(await itemRow.get(row.id)));
  });

  app.delete('/api/v1/catalog/:itemId', requireSession, async (request, response) => {
    const row = await ownItem(request, response);
    if (!row) return;
    await db.prepare('DELETE FROM catalog_items WHERE id = ?').run(row.id);
    if (row.imageDiskName) await unlink(join(catalogDirectory, row.imageDiskName)).catch(() => {});
    response.status(204).end();
  });

  app.put('/api/v1/catalog/:itemId/image', requireSession, express.raw({ type: () => true, limit: MAX_CATALOG_IMAGE_BYTES }), async (request, response) => {
    const row = await ownItem(request, response);
    if (!row) return;
    const image = detectImage(request.body);
    if (!image) return response.status(415).json({ error: 'Choose a JPEG, PNG, WebP or GIF image.' });
    const at = now();
    const diskName = `${row.id}-${at}.${image.extension}`;
    await writeFile(join(catalogDirectory, diskName), request.body, { flag: 'wx' });
    await db.prepare('UPDATE catalog_items SET image_disk_name = ?, image_type = ?, updated_at = ? WHERE id = ?').run(diskName, image.type, at, row.id);
    if (row.imageDiskName) await unlink(join(catalogDirectory, row.imageDiskName)).catch(() => {});
    response.json(presentItem(await itemRow.get(row.id)));
  });

  app.get('/api/v1/catalog/:itemId/image', requireSession, async (request, response) => {
    const row = await db.prepare('SELECT user_id AS "userId", hidden, image_disk_name AS "diskName", image_type AS "type" FROM catalog_items WHERE id = ?').get(request.params.itemId);
    if (!row?.diskName || (Number(row.hidden) === 1 && row.userId !== request.session.user_id)) return response.status(404).json({ error: 'No image.' });
    const body = await readFile(join(catalogDirectory, row.diskName)).catch(() => null);
    if (!body) return response.status(404).json({ error: 'No image.' });
    response.set({ 'Content-Type': row.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" });
    response.send(body);
  });

  // --- Business: labels ---------------------------------------------------------------------------------------
  async function labelsOf(userId) {
    const labels = await db.prepare('SELECT id, name, color, created_at AS "createdAt" FROM labels WHERE user_id = ? ORDER BY created_at, id').all(userId);
    const chats = await db.prepare('SELECT lc.label_id AS "labelId", lc.chat_key AS "chatKey" FROM label_chats lc JOIN labels l ON l.id = lc.label_id WHERE l.user_id = ?').all(userId);
    return labels.map((label) => ({ id: label.id, name: label.name, color: Number(label.color), chatKeys: chats.filter((chat) => chat.labelId === label.id).map((chat) => chat.chatKey) }));
  }
  const labelChanged = async (userId) => broadcastUser(userId, { type: 'labels:changed' });
  function parseLabel(body, current = {}) {
    const name = body?.name === undefined ? current.name : boundedText(body.name, 40, { required: true });
    const color = body?.color === undefined ? current.color ?? 0 : body.color;
    if (name === undefined || !Number.isInteger(color) || color < 0 || color >= LABEL_COLORS) return null;
    return { name, color };
  }
  async function ownLabel(request, response) {
    const label = await db.prepare('SELECT id, name, color FROM labels WHERE id = ? AND user_id = ?').get(request.params.labelId, request.session.user_id);
    if (!label) response.status(404).json({ error: 'Label not found.' });
    return label;
  }

  app.get('/api/v1/labels', requireSession, async (request, response) => response.json(await labelsOf(request.session.user_id)));

  app.post('/api/v1/labels', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const label = parseLabel(request.body);
    if (!label) return response.status(400).json({ error: 'A label needs a name (up to 40 characters) and a colour.' });
    if (Number((await db.prepare('SELECT count(*) AS "count" FROM labels WHERE user_id = ?').get(userId)).count) >= MAX_LABELS) return response.status(409).json({ error: 'You can have up to 20 labels.' });
    if (await db.prepare('SELECT 1 FROM labels WHERE user_id = ? AND lower(name) = lower(?)').get(userId, label.name)) return response.status(409).json({ error: 'You already have a label with that name.' });
    const id = randomUUID();
    await db.prepare('INSERT INTO labels(id, user_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, label.name, label.color, now());
    await labelChanged(userId);
    response.status(201).json({ id, ...label, chatKeys: [] });
  });

  app.put('/api/v1/labels/:labelId', requireSession, async (request, response) => {
    const current = await ownLabel(request, response);
    if (!current) return;
    const label = parseLabel(request.body, { ...current, color: Number(current.color) });
    if (!label) return response.status(400).json({ error: 'A label needs a name (up to 40 characters) and a colour.' });
    await db.prepare('UPDATE labels SET name = ?, color = ? WHERE id = ?').run(label.name, label.color, current.id);
    await labelChanged(request.session.user_id);
    response.json((await labelsOf(request.session.user_id)).find((item) => item.id === current.id));
  });

  app.delete('/api/v1/labels/:labelId', requireSession, async (request, response) => {
    const current = await ownLabel(request, response);
    if (!current) return;
    await db.prepare('DELETE FROM label_chats WHERE label_id = ?').run(current.id);
    await db.prepare('DELETE FROM labels WHERE id = ?').run(current.id);
    await labelChanged(request.session.user_id);
    response.status(204).end();
  });

  app.put('/api/v1/labels/:labelId/chats/:chatKey', requireSession, async (request, response) => {
    const current = await ownLabel(request, response);
    if (!current) return;
    const chat = parseChatKey(request.params.chatKey);
    if (!chat || typeof request.body?.assigned !== 'boolean') return response.status(400).json({ error: 'Choose a chat and whether it has this label.' });
    if (request.body.assigned) await db.prepare('INSERT INTO label_chats(label_id, chat_key) VALUES (?, ?) ON CONFLICT DO NOTHING').run(current.id, chat.key);
    else await db.prepare('DELETE FROM label_chats WHERE label_id = ? AND chat_key = ?').run(current.id, chat.key);
    await labelChanged(request.session.user_id);
    response.json({ labelId: current.id, chatKey: chat.key, assigned: request.body.assigned });
  });

  // --- Business: quick replies --------------------------------------------------------------------------------
  const quickReplies = (userId) => db.prepare('SELECT id, shortcut, text FROM quick_replies WHERE user_id = ? ORDER BY shortcut').all(userId);
  function parseQuickReply(body, current = {}) {
    const shortcut = body?.shortcut === undefined ? current.shortcut : (typeof body.shortcut === 'string' ? body.shortcut.trim().replace(/^\//, '').toLowerCase() : '');
    const replyText = body?.text === undefined ? current.text : boundedText(body.text, 1000, { required: true });
    if (!SHORTCUT_PATTERN.test(shortcut ?? '') || replyText === undefined) return null;
    return { shortcut, text: replyText };
  }

  app.get('/api/v1/quick-replies', requireSession, async (request, response) => response.json(await quickReplies(request.session.user_id)));

  app.post('/api/v1/quick-replies', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const reply = parseQuickReply(request.body);
    if (!reply) return response.status(400).json({ error: 'A shortcut is 1–25 lowercase letters, digits or _ and the reply up to 1,000 characters.' });
    if (Number((await db.prepare('SELECT count(*) AS "count" FROM quick_replies WHERE user_id = ?').get(userId)).count) >= MAX_QUICK_REPLIES) return response.status(409).json({ error: 'You can have up to 50 quick replies.' });
    if (await db.prepare('SELECT 1 FROM quick_replies WHERE user_id = ? AND shortcut = ?').get(userId, reply.shortcut)) return response.status(409).json({ error: `You already have /${reply.shortcut}.` });
    const id = randomUUID();
    await db.prepare('INSERT INTO quick_replies(id, user_id, shortcut, text, created_at) VALUES (?, ?, ?, ?, ?)').run(id, userId, reply.shortcut, reply.text, now());
    broadcastUser(userId, { type: 'quick-replies:changed' });
    response.status(201).json({ id, ...reply });
  });

  app.put('/api/v1/quick-replies/:replyId', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const current = await db.prepare('SELECT id, shortcut, text FROM quick_replies WHERE id = ? AND user_id = ?').get(request.params.replyId, userId);
    if (!current) return response.status(404).json({ error: 'Quick reply not found.' });
    const reply = parseQuickReply(request.body, current);
    if (!reply) return response.status(400).json({ error: 'A shortcut is 1–25 lowercase letters, digits or _ and the reply up to 1,000 characters.' });
    if (reply.shortcut !== current.shortcut && await db.prepare('SELECT 1 FROM quick_replies WHERE user_id = ? AND shortcut = ?').get(userId, reply.shortcut)) {
      return response.status(409).json({ error: `You already have /${reply.shortcut}.` });
    }
    await db.prepare('UPDATE quick_replies SET shortcut = ?, text = ? WHERE id = ?').run(reply.shortcut, reply.text, current.id);
    broadcastUser(userId, { type: 'quick-replies:changed' });
    response.json({ id: current.id, ...reply });
  });

  app.delete('/api/v1/quick-replies/:replyId', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    await db.prepare('DELETE FROM quick_replies WHERE id = ? AND user_id = ?').run(request.params.replyId, userId);
    broadcastUser(userId, { type: 'quick-replies:changed' });
    response.status(204).end();
  });

  // --- Business: away and greeting messages -------------------------------------------------------------------
  const businessRow = db.prepare(`SELECT away_enabled AS "awayEnabled", away_text AS "awayText", away_schedule AS "awaySchedule",
    away_hours AS "awayHours", greeting_enabled AS "greetingEnabled", greeting_text AS "greetingText" FROM business_profiles WHERE user_id = ?`);
  const hoursOf = (row) => { try { return row?.awayHours ? parseBusinessHours(JSON.parse(row.awayHours)) ?? null : null; } catch { return null; } };
  const presentBusiness = (row) => ({
    // `hours`: when set, the away message goes out only outside these business hours.
    away: { enabled: Number(row?.awayEnabled) === 1, text: row?.awayText ?? '', schedule: row?.awaySchedule ?? 'always', hours: hoursOf(row) },
    greeting: { enabled: Number(row?.greetingEnabled) === 1, text: row?.greetingText ?? '' },
  });

  app.get('/api/v1/business', requireSession, async (request, response) => response.json(presentBusiness(await businessRow.get(request.session.user_id))));

  app.put('/api/v1/business', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const current = presentBusiness(await businessRow.get(userId));
    const away = { ...current.away, ...(request.body?.away ?? {}) };
    const greeting = { ...current.greeting, ...(request.body?.greeting ?? {}) };
    const awayText = boundedText(away.text, 1000);
    const greetingText = boundedText(greeting.text, 1000);
    if (typeof away.enabled !== 'boolean' || typeof greeting.enabled !== 'boolean' || !['always', 'offline'].includes(away.schedule)
      || awayText === undefined || greetingText === undefined || (away.enabled && !awayText) || (greeting.enabled && !greetingText)) {
      return response.status(400).json({ error: 'Write the message (up to 1,000 characters) before turning it on.' });
    }
    const hours = parseBusinessHours(away.hours);
    if (hours === undefined) return response.status(400).json({ error: 'Business hours need a time zone and opening times that end after they start.' });
    await db.prepare(`INSERT INTO business_profiles(user_id, away_enabled, away_text, away_schedule, away_hours, greeting_enabled, greeting_text, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET away_enabled = excluded.away_enabled, away_text = excluded.away_text,
      away_schedule = excluded.away_schedule, away_hours = excluded.away_hours, greeting_enabled = excluded.greeting_enabled, greeting_text = excluded.greeting_text, updated_at = excluded.updated_at`)
      .run(userId, bool(away.enabled), awayText, away.schedule, hours ? JSON.stringify(hours) : null, bool(greeting.enabled), greetingText, now());
    response.json(presentBusiness(await businessRow.get(userId)));
  });

  /**
   * After a direct message is stored (not for automatic replies): the recipient's greeting (first message, or after
   * 14 quiet days) and away message (at most once a day per person; "offline" = only while they have no app open).
   */
  async function afterDirectMessage({ senderId, receiverId, messageId }) {
    const profile = await businessRow.get(receiverId);
    if (!profile || (!Number(profile.greetingEnabled) && !Number(profile.awayEnabled))) return;
    const at = now();
    const sentRecently = async (kind, windowMs) => {
      const row = await db.prepare('SELECT sent_at AS "sentAt" FROM business_auto_replies WHERE user_id = ? AND peer_id = ? AND kind = ?').get(receiverId, senderId, kind);
      return row && at - Number(row.sentAt) < windowMs;
    };
    const record = (kind) => db.prepare(`INSERT INTO business_auto_replies(user_id, peer_id, kind, sent_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, peer_id, kind) DO UPDATE SET sent_at = excluded.sent_at`).run(receiverId, senderId, kind, at);
    if (Number(profile.greetingEnabled) === 1 && profile.greetingText) {
      const since = new Date(at - GREETING_QUIET_MS).toISOString();
      const earlier = await db.prepare(`SELECT 1 FROM messages WHERE id <> ? AND created_at > ?
        AND ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)) LIMIT 1`).get(messageId, since, senderId, receiverId, receiverId, senderId);
      if (!earlier && !await sentRecently('greeting', GREETING_QUIET_MS)) {
        await record('greeting');
        await deliverDirectMessage({ senderId: receiverId, receiverId: senderId, content: profile.greetingText });
      }
    }
    const hours = hoursOf(profile);
    if (Number(profile.awayEnabled) === 1 && profile.awayText && (profile.awaySchedule === 'always' || !isOnline(receiverId))
      && !(hours && withinBusinessHours(hours, at)) && !await sentRecently('away', AWAY_INTERVAL_MS)) {
      await record('away');
      await deliverDirectMessage({ senderId: receiverId, receiverId: senderId, content: profile.awayText });
    }
  }

  // --- Two-step verification ----------------------------------------------------------------------------------
  const twoStepRow = db.prepare('SELECT password_hash AS "passwordHash", two_step_hash AS "pinHash", two_step_set_at AS "setAt" FROM users WHERE id = ?');

  app.get('/api/v1/me/two-step', requireSession, async (request, response) => {
    const row = await twoStepRow.get(request.session.user_id);
    response.json({ enabled: Boolean(row?.pinHash), setAt: row?.setAt ? Number(row.setAt) : null });
  });

  // Turning it on or changing the PIN needs the account password, so a borrowed unlocked phone can't lock you out.
  app.put('/api/v1/me/two-step', requireSession, async (request, response) => {
    const { pin, password } = request.body ?? {};
    if (!validPin(pin)) return response.status(400).json({ error: 'The PIN is 6 digits.' });
    const row = await twoStepRow.get(request.session.user_id);
    if (!row?.passwordHash || typeof password !== 'string' || !await verifyPassword(password, row.passwordHash)) return response.status(403).json({ error: 'Your password is incorrect.' });
    const setAt = now();
    await db.prepare('UPDATE users SET two_step_hash = ?, two_step_set_at = ? WHERE id = ?').run(await hashPassword(pin), setAt, request.session.user_id);
    response.json({ enabled: true, setAt });
  });

  app.delete('/api/v1/me/two-step', requireSession, async (request, response) => {
    const row = await twoStepRow.get(request.session.user_id);
    const password = request.body?.password;
    if (!row?.passwordHash || typeof password !== 'string' || !await verifyPassword(password, row.passwordHash)) return response.status(403).json({ error: 'Your password is incorrect.' });
    await db.prepare('UPDATE users SET two_step_hash = NULL, two_step_set_at = NULL WHERE id = ?').run(request.session.user_id);
    response.json({ enabled: false });
  });

  const reminderThrottle = createLoginThrottle();
  // The periodic "confirm your PIN" reminder (helps you remember it); wrong guesses are throttled like sign-in.
  app.post('/api/v1/me/two-step/verify', requireSession, async (request, response) => {
    const keys = [`pin:${request.session.user_id}`];
    const wait = reminderThrottle.retryAfter(keys);
    if (wait) return response.status(429).set('Retry-After', String(Math.ceil(wait / 1000))).json({ error: 'Too many attempts. Try again later.', retryAfterMs: wait });
    const row = await twoStepRow.get(request.session.user_id);
    if (!row?.pinHash) return response.status(409).json({ error: 'Two-step verification is off.' });
    const correct = validPin(request.body?.pin) && await verifyPassword(request.body.pin, row.pinHash);
    if (!correct) {
      reminderThrottle.fail(keys);
      return response.status(400).json({ error: 'That PIN is incorrect.', correct: false });
    }
    reminderThrottle.succeed(keys);
    response.json({ correct: true });
  });

  /** Sign-in's second step: null when no PIN is set or the PIN matches, else the error body. */
  async function checkTwoStep(userId, pin) {
    const row = await twoStepRow.get(userId);
    if (!row?.pinHash) return null;
    if (pin === undefined || pin === null || pin === '') return { error: 'Enter your two-step verification PIN.', twoStepRequired: true };
    if (!validPin(pin) || !await verifyPassword(pin, row.pinHash)) return { error: 'That PIN is incorrect.', twoStepRequired: true, wrongPin: true };
    return null;
  }

  return { groupExtras, canPostToGroup, afterDirectMessage, afterMemberAdded, checkTwoStep };
}
