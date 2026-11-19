// Hidden Messenger Support: each account's conversation with the official "Hidden Messenger" account, like a business
// messenger's verified support chat. The person writes from the app (the chat list's pinned Hidden Messenger row, or
// Help Center › Contact us); admins read and answer in the admin console, with a photo, video or PDF if they like, and
// an answer reaches every device of that person at once. A campaign is one message from the admin console to everyone:
// it lands in each account's support chat (Postgres: migrations 024 and 041).
//
// Support messages are NOT end-to-end encrypted: the support team has to read them. The app says so above the chat.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';

export const SUPPORT_MESSAGE_MAX = 2000;
// A person may send this many support messages per hour (a conversation, not a mailbox to flood).
export const SUPPORT_HOURLY_LIMIT = 30;
// A support attachment: within the site's request limit (deploy/nginx.conf, client_max_body_size 16m).
export const SUPPORT_MEDIA_MAX_BYTES = 15 * 1024 * 1024;
const PAGE = 200;

export function ensureSupportSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS support_messages (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, from_admin INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
    created_at INTEGER NOT NULL, read_by_user_at INTEGER, read_by_admin_at INTEGER
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS support_messages_user ON support_messages(user_id, created_at)');
  const columns = new Set(db.prepare('PRAGMA table_info(support_messages)').all().map((column) => column.name));
  if (!columns.has('media_id')) db.exec('ALTER TABLE support_messages ADD COLUMN media_id TEXT');
  if (!columns.has('campaign_id')) db.exec('ALTER TABLE support_messages ADD COLUMN campaign_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS support_messages_campaign ON support_messages(campaign_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS support_media (
    id TEXT PRIMARY KEY, disk_name TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS support_campaigns (
    id TEXT PRIMARY KEY, body TEXT NOT NULL, media_id TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
}

/** What an attachment is, from its first bytes (never the name or the declared type). */
export function detectSupportMedia(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  const ascii = (start, end) => bytes.subarray(start, end).toString('latin1');
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image/jpeg', extension: 'jpg', kind: 'image' };
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', extension: 'png', kind: 'image' };
  if (ascii(0, 4) === 'GIF8') return { type: 'image/gif', extension: 'gif', kind: 'image' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { type: 'image/webp', extension: 'webp', kind: 'image' };
  if (ascii(4, 8) === 'ftyp') return { type: 'video/mp4', extension: 'mp4', kind: 'video' };
  if (bytes.readUInt32BE(0) === 0x1a45dfa3) return { type: 'video/webm', extension: 'webm', kind: 'video' };
  if (ascii(0, 5) === '%PDF-') return { type: 'application/pdf', extension: 'pdf', kind: 'file' };
  return null;
}

// A file name to show: no path, no control characters, not too long.
const cleanName = (value, fallback) => {
  let name = '';
  try { name = decodeURIComponent(String(value ?? '')); } catch { name = ''; }
  name = name.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  return name || fallback;
};
const kindOf = (type) => (type?.startsWith('image/') ? 'image' : type?.startsWith('video/') ? 'video' : 'file');

const present = (row, mediaBase) => ({
  id: row.id,
  fromSupport: Boolean(Number(row.fromAdmin)),
  body: row.body,
  createdAt: Number(row.createdAt),
  readByUser: row.readByUserAt != null,
  readBySupport: row.readByAdminAt != null,
  media: row.mediaId ? { id: row.mediaId, type: row.mediaType, kind: kindOf(row.mediaType), name: row.mediaName, size: Number(row.mediaSize), url: `${mediaBase}/${row.mediaId}` } : null,
  campaign: Boolean(row.campaignId),
});
const COLUMNS = `m.id, m.from_admin AS "fromAdmin", m.body, m.created_at AS "createdAt", m.read_by_user_at AS "readByUserAt",
  m.read_by_admin_at AS "readByAdminAt", m.media_id AS "mediaId", m.campaign_id AS "campaignId", d.type AS "mediaType", d.name AS "mediaName", d.size AS "mediaSize"`;
const cleanBody = (value) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '');
// What a conversation list shows for a message: its text, else what was attached.
const previewOf = (body, mediaType) => (body ? body.slice(0, 160) : mediaType ? { image: '📷 Photo', video: '🎥 Video', file: '📄 Document' }[kindOf(mediaType)] : '');

export const USER_MEDIA_BASE = '/api/v1/support/media';
export const ADMIN_MEDIA_BASE = '/api/admin/v1/support-media';

export function registerSupport({ app, db, requireSession, requireAdmin, notifyUser, broadcastUser, publicUser, userColumns, dataDirectory }) {
  const fail = (response, status, error) => response.status(status).json({ error });
  const mediaDirectory = join(dataDirectory, 'support-media');
  mkdirSync(mediaDirectory, { recursive: true });
  const conversation = (userId) => db.prepare(`SELECT * FROM (SELECT ${COLUMNS} FROM support_messages m LEFT JOIN support_media d ON d.id = m.media_id
    WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT ${PAGE}) AS newest ORDER BY "createdAt" ASC`).all(userId);
  // A support conversation is open once the person asked for help or support wrote to them directly; campaigns alone
  // do not open one (they are announcements, and cannot be answered).
  const conversationOpen = async (userId) => Boolean(await db.prepare('SELECT 1 AS "found" FROM support_messages WHERE user_id = ? AND campaign_id IS NULL LIMIT 1').get(userId));
  const mediaRow = (id) => db.prepare('SELECT id, disk_name AS "diskName", type, name, size FROM support_media WHERE id = ?').get(String(id ?? ''));

  function sendMedia(response, media) {
    response.set({
      'Content-Type': media.type,
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; media-src 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${kindOf(media.type) === 'file' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(media.name)}`,
      'Cache-Control': 'private, max-age=86400, immutable', // an id is never reused for other bytes
    });
    response.sendFile(media.diskName, { root: mediaDirectory, cacheControl: false, dotfiles: 'deny' }, (error) => {
      if (error && !response.headersSent) fail(response, 404, 'No such attachment.');
    });
  }

  // A message's text and attachment, checked: one of the two, the text within the limit, the attachment uploaded.
  async function composed(request, response, noun) {
    const body = cleanBody(request.body?.body);
    const mediaId = request.body?.mediaId ? String(request.body.mediaId) : null;
    if (body.length > SUPPORT_MESSAGE_MAX || (!body && !mediaId)) {
      fail(response, 400, `Write a ${noun} of up to ${SUPPORT_MESSAGE_MAX.toLocaleString('en-US')} characters, or attach a file.`);
      return null;
    }
    const media = mediaId ? await mediaRow(mediaId) : null;
    if (mediaId && !media) { fail(response, 400, 'Attach the file again: it was not found.'); return null; }
    return { body, media };
  }
  const messageWith = (fields, media) => ({
    ...fields,
    media: media ? { id: media.id, type: media.type, kind: kindOf(media.type), name: media.name, size: Number(media.size), url: `${USER_MEDIA_BASE}/${media.id}` } : null,
  });

  // --- The person's side ---
  app.get('/api/v1/support/messages', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const rows = await conversation(userId);
    await db.prepare('UPDATE support_messages SET read_by_user_at = ? WHERE user_id = ? AND from_admin = 1 AND read_by_user_at IS NULL').run(Date.now(), userId);
    response.json({ messages: rows.map((row) => present(row, USER_MEDIA_BASE)), replies: rows.some((row) => !row.campaignId) ? 'open' : 'closed' });
  });

  // The chat list's pinned Hidden Messenger row: the newest message and how many from support are unread. Reads nothing.
  app.get('/api/v1/support/summary', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const last = await db.prepare(`SELECT m.body, m.from_admin AS "fromAdmin", m.created_at AS "createdAt", d.type AS "mediaType"
      FROM support_messages m LEFT JOIN support_media d ON d.id = m.media_id WHERE m.user_id = ? ORDER BY m.created_at DESC LIMIT 1`).get(userId);
    const unread = Number((await db.prepare('SELECT count(*) AS "count" FROM support_messages WHERE user_id = ? AND from_admin = 1 AND read_by_user_at IS NULL').get(userId))?.count ?? 0);
    response.json({
      last: last ? { preview: previewOf(last.body, last.mediaType), fromSupport: Boolean(Number(last.fromAdmin)), createdAt: Number(last.createdAt) } : null,
      unread,
    });
  });

  // An attachment of this person's own conversation (a reply to them, or a campaign they received).
  app.get(`${USER_MEDIA_BASE}/:mediaId`, requireSession, async (request, response) => {
    const owned = await db.prepare('SELECT 1 AS "found" FROM support_messages WHERE user_id = ? AND media_id = ? LIMIT 1').get(request.session.user_id, request.params.mediaId);
    const media = owned ? await mediaRow(request.params.mediaId) : null;
    if (!media) return fail(response, 404, 'No such attachment.');
    sendMedia(response, media);
  });

  app.post('/api/v1/support/messages', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const body = cleanBody(request.body?.body);
    if (!body || body.length > SUPPORT_MESSAGE_MAX) return fail(response, 400, `Write a message of up to ${SUPPORT_MESSAGE_MAX.toLocaleString('en-US')} characters.`);
    // Campaigns are read-only: writing needs an open conversation, or an explicit new request (Contact support).
    if (request.body?.start !== true && !(await conversationOpen(userId))) {
      return fail(response, 403, 'Only Hidden Messenger can send messages here. To get help, choose Contact support.');
    }
    const now = Date.now();
    const recent = Number((await db.prepare('SELECT count(*) AS "count" FROM support_messages WHERE user_id = ? AND from_admin = 0 AND created_at >= ?').get(userId, now - 60 * 60 * 1000))?.count ?? 0);
    if (recent >= SUPPORT_HOURLY_LIMIT) return fail(response, 429, 'You’ve sent a lot of messages to support this hour. Please wait for a reply.');
    const id = randomUUID();
    await db.prepare('INSERT INTO support_messages(id, user_id, from_admin, body, created_at) VALUES (?, ?, 0, ?, ?)').run(id, userId, body, now);
    const message = { id, fromSupport: false, body, createdAt: now, readByUser: false, readBySupport: false, media: null, campaign: false };
    // The person's other devices show it too.
    await notifyUser(userId, { type: 'support:message', message });
    response.status(201).json(message);
  });

  // --- The support team's side (admin console) ---
  const prefixed = userColumns.split(',').map((column) => `u.${column.trim()}`).join(', ');

  // An attachment for a reply or a campaign: uploaded first, then named by the message that carries it.
  app.post(ADMIN_MEDIA_BASE, requireAdmin, express.raw({ type: () => true, limit: SUPPORT_MEDIA_MAX_BYTES }), async (request, response) => {
    const detected = Buffer.isBuffer(request.body) ? detectSupportMedia(request.body) : null;
    if (!detected) return fail(response, 415, 'Attach a photo (JPEG, PNG, WebP, GIF), a video (MP4, WebM) or a PDF.');
    const id = randomUUID();
    const diskName = `${id}.${detected.extension}`;
    const name = cleanName(request.get('x-file-name'), `attachment.${detected.extension}`);
    await writeFile(join(mediaDirectory, diskName), request.body, { flag: 'wx' });
    try {
      await db.prepare('INSERT INTO support_media(id, disk_name, type, name, size, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, diskName, detected.type, name, request.body.length, Date.now());
    } catch (error) {
      await unlink(join(mediaDirectory, diskName)).catch(() => {});
      throw error;
    }
    response.status(201).json({ media: { id, type: detected.type, kind: detected.kind, name, size: request.body.length } });
  });

  app.get(`${ADMIN_MEDIA_BASE}/:mediaId`, requireAdmin, async (request, response) => {
    const media = await mediaRow(request.params.mediaId);
    if (!media) return fail(response, 404, 'No such attachment.');
    sendMedia(response, media);
  });

  // Conversations people started or were answered in (a campaign alone does not open a conversation here).
  app.get('/api/admin/v1/support', requireAdmin, async (_request, response) => {
    const rows = await db.prepare(`SELECT ${prefixed}, s.last_at AS "lastAt", s.unread AS "unread", m.body AS "lastBody", m.from_admin AS "lastFromAdmin", d.type AS "lastMediaType"
      FROM (SELECT user_id, max(created_at) AS last_at, sum(CASE WHEN from_admin = 0 AND read_by_admin_at IS NULL THEN 1 ELSE 0 END) AS unread
            FROM support_messages WHERE campaign_id IS NULL GROUP BY user_id) s
      JOIN users u ON u.id = s.user_id
      JOIN support_messages m ON m.user_id = s.user_id AND m.created_at = s.last_at AND m.campaign_id IS NULL
      LEFT JOIN support_media d ON d.id = m.media_id
      ORDER BY s.last_at DESC LIMIT ${PAGE}`).all();
    const seen = new Set();
    response.json({
      threads: rows.filter((row) => !seen.has(row.id) && seen.add(row.id)).map((row) => ({
        user: publicUser(row),
        lastAt: Number(row.lastAt),
        unread: Number(row.unread ?? 0),
        last: { body: previewOf(row.lastBody, row.lastMediaType), fromSupport: Boolean(Number(row.lastFromAdmin)) },
      })),
    });
  });

  // Campaigns: one message to every active account, newest first, with how many have seen it.
  app.get('/api/admin/v1/support-campaigns', requireAdmin, async (_request, response) => {
    const rows = await db.prepare(`SELECT c.id, c.body, c.created_by AS "createdBy", c.created_at AS "createdAt", c.media_id AS "mediaId", d.type AS "mediaType", d.name AS "mediaName", d.size AS "mediaSize",
        (SELECT count(*) FROM support_messages s WHERE s.campaign_id = c.id) AS "recipients",
        (SELECT count(*) FROM support_messages s WHERE s.campaign_id = c.id AND s.read_by_user_at IS NOT NULL) AS "seen"
      FROM support_campaigns c LEFT JOIN support_media d ON d.id = c.media_id ORDER BY c.created_at DESC LIMIT 50`).all();
    response.json({
      campaigns: rows.map((row) => ({
        id: row.id, body: row.body, createdBy: row.createdBy, createdAt: Number(row.createdAt), recipients: Number(row.recipients), seen: Number(row.seen),
        media: row.mediaId ? { id: row.mediaId, type: row.mediaType, kind: kindOf(row.mediaType), name: row.mediaName, size: Number(row.mediaSize), url: `${ADMIN_MEDIA_BASE}/${row.mediaId}` } : null,
      })),
    });
  });

  app.post('/api/admin/v1/support-campaigns', requireAdmin, async (request, response) => {
    const message = await composed(request, response, 'campaign message');
    if (!message) return;
    const id = randomUUID();
    const now = Date.now();
    const mediaId = message.media?.id ?? null;
    await db.prepare('INSERT INTO support_campaigns(id, body, media_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(id, message.body, mediaId, request.admin.actor, now);
    // One row per active account, made in the database (a message id per account: the campaign's and the account's).
    await db.prepare(`INSERT INTO support_messages(id, user_id, from_admin, body, created_at, read_by_admin_at, media_id, campaign_id)
      SELECT CAST(? AS TEXT) || ':' || id, id, 1, CAST(? AS TEXT), CAST(? AS BIGINT), CAST(? AS BIGINT), CAST(? AS TEXT), CAST(? AS TEXT) FROM users WHERE suspended_at IS NULL AND deleted_at IS NULL`).run(id, message.body, now, now, mediaId, id);
    const recipients = await db.prepare('SELECT user_id AS "userId" FROM support_messages WHERE campaign_id = ?').all(id);
    // Open apps show it at once; the others see it in the pinned row when they next open the chat list.
    for (const { userId } of recipients) {
      broadcastUser(userId, { type: 'support:message', message: messageWith({ id: `${id}:${userId}`, fromSupport: true, body: message.body, createdAt: now, readByUser: false, readBySupport: true, campaign: true }, message.media) });
    }
    response.status(201).json({ id, recipients: recipients.length });
  });

  app.get('/api/admin/v1/support/:userId', requireAdmin, async (request, response) => {
    const user = await db.prepare(`SELECT ${userColumns} FROM users WHERE id = ?`).get(request.params.userId);
    if (!user) return fail(response, 404, 'No such account.');
    const rows = await conversation(user.id);
    await db.prepare('UPDATE support_messages SET read_by_admin_at = ? WHERE user_id = ? AND from_admin = 0 AND read_by_admin_at IS NULL').run(Date.now(), user.id);
    response.json({ user: publicUser(user), messages: rows.map((row) => present(row, ADMIN_MEDIA_BASE)) });
  });

  app.post('/api/admin/v1/support/:userId', requireAdmin, async (request, response) => {
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(request.params.userId);
    if (!user) return fail(response, 404, 'No such account.');
    const reply = await composed(request, response, 'reply');
    if (!reply) return;
    const id = randomUUID();
    const now = Date.now();
    await db.prepare('INSERT INTO support_messages(id, user_id, from_admin, body, created_at, media_id) VALUES (?, ?, 1, ?, ?, ?)').run(id, user.id, reply.body, now, reply.media?.id ?? null);
    const message = messageWith({ id, fromSupport: true, body: reply.body, createdAt: now, readByUser: false, readBySupport: true, campaign: false }, reply.media);
    await notifyUser(user.id, { type: 'support:message', message });
    response.status(201).json(message);
  });

  /** Conversations with a message the support team hasn't read yet (the admin console's badge). */
  return {
    unanswered: async () => Number((await db.prepare('SELECT count(DISTINCT user_id) AS "count" FROM support_messages WHERE from_admin = 0 AND read_by_admin_at IS NULL').get())?.count ?? 0),
  };
}
