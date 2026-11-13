// Hidden Messenger Support: each account's conversation with the support team, like a business messenger's "Contact
// us" chat with its official support account. The person writes from the app (Help Center › Contact us); admins
// read and answer in the admin console, and an answer reaches every device of that person at once.
//
// Support messages are NOT end-to-end encrypted: the support team has to read them. The app says so above the chat.
import { randomUUID } from 'node:crypto';

export const SUPPORT_MESSAGE_MAX = 2000;
// A person may send this many support messages per hour (a conversation, not a mailbox to flood).
export const SUPPORT_HOURLY_LIMIT = 30;
const PAGE = 200;

export function ensureSupportSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS support_messages (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, from_admin INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
    created_at INTEGER NOT NULL, read_by_user_at INTEGER, read_by_admin_at INTEGER
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS support_messages_user ON support_messages(user_id, created_at)');
}

const present = (row) => ({
  id: row.id,
  fromSupport: Boolean(Number(row.fromAdmin)),
  body: row.body,
  createdAt: Number(row.createdAt),
  readByUser: row.readByUserAt != null,
  readBySupport: row.readByAdminAt != null,
});
const COLUMNS = 'id, from_admin AS "fromAdmin", body, created_at AS "createdAt", read_by_user_at AS "readByUserAt", read_by_admin_at AS "readByAdminAt"';
const cleanBody = (value) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '');

export function registerSupport({ app, db, requireSession, requireAdmin, notifyUser, publicUser, userColumns }) {
  const fail = (response, status, error) => response.status(status).json({ error });
  const conversation = (userId) => db.prepare(`SELECT * FROM (SELECT ${COLUMNS} FROM support_messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ${PAGE}) AS newest ORDER BY "createdAt" ASC`).all(userId);

  // --- The person's side ---
  app.get('/api/v1/support/messages', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const rows = await conversation(userId);
    await db.prepare('UPDATE support_messages SET read_by_user_at = ? WHERE user_id = ? AND from_admin = 1 AND read_by_user_at IS NULL').run(Date.now(), userId);
    response.json({ messages: rows.map(present) });
  });

  app.post('/api/v1/support/messages', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const body = cleanBody(request.body?.body);
    if (!body || body.length > SUPPORT_MESSAGE_MAX) return fail(response, 400, `Write a message of up to ${SUPPORT_MESSAGE_MAX.toLocaleString('en-US')} characters.`);
    const now = Date.now();
    const recent = Number((await db.prepare('SELECT count(*) AS "count" FROM support_messages WHERE user_id = ? AND from_admin = 0 AND created_at >= ?').get(userId, now - 60 * 60 * 1000))?.count ?? 0);
    if (recent >= SUPPORT_HOURLY_LIMIT) return fail(response, 429, 'You’ve sent a lot of messages to support this hour. Please wait for a reply.');
    const id = randomUUID();
    await db.prepare('INSERT INTO support_messages(id, user_id, from_admin, body, created_at) VALUES (?, ?, 0, ?, ?)').run(id, userId, body, now);
    const message = { id, fromSupport: false, body, createdAt: now, readByUser: false, readBySupport: false };
    // The person's other devices show it too.
    await notifyUser(userId, { type: 'support:message', message });
    response.status(201).json(message);
  });

  // --- The support team's side (admin console) ---
  const prefixed = userColumns.split(',').map((column) => `u.${column.trim()}`).join(', ');

  app.get('/api/admin/v1/support', requireAdmin, async (_request, response) => {
    const rows = await db.prepare(`SELECT ${prefixed}, s.last_at AS "lastAt", s.unread AS "unread", m.body AS "lastBody", m.from_admin AS "lastFromAdmin"
      FROM (SELECT user_id, max(created_at) AS last_at, sum(CASE WHEN from_admin = 0 AND read_by_admin_at IS NULL THEN 1 ELSE 0 END) AS unread
            FROM support_messages GROUP BY user_id) s
      JOIN users u ON u.id = s.user_id
      JOIN support_messages m ON m.user_id = s.user_id AND m.created_at = s.last_at
      ORDER BY s.last_at DESC LIMIT ${PAGE}`).all();
    const seen = new Set();
    response.json({
      threads: rows.filter((row) => !seen.has(row.id) && seen.add(row.id)).map((row) => ({
        user: publicUser(row),
        lastAt: Number(row.lastAt),
        unread: Number(row.unread ?? 0),
        last: { body: row.lastBody.slice(0, 160), fromSupport: Boolean(Number(row.lastFromAdmin)) },
      })),
    });
  });

  app.get('/api/admin/v1/support/:userId', requireAdmin, async (request, response) => {
    const user = await db.prepare(`SELECT ${userColumns} FROM users WHERE id = ?`).get(request.params.userId);
    if (!user) return fail(response, 404, 'No such account.');
    const rows = await conversation(user.id);
    await db.prepare('UPDATE support_messages SET read_by_admin_at = ? WHERE user_id = ? AND from_admin = 0 AND read_by_admin_at IS NULL').run(Date.now(), user.id);
    response.json({ user: publicUser(user), messages: rows.map(present) });
  });

  app.post('/api/admin/v1/support/:userId', requireAdmin, async (request, response) => {
    const user = await db.prepare('SELECT id FROM users WHERE id = ?').get(request.params.userId);
    if (!user) return fail(response, 404, 'No such account.');
    const body = cleanBody(request.body?.body);
    if (!body || body.length > SUPPORT_MESSAGE_MAX) return fail(response, 400, `Write a reply of up to ${SUPPORT_MESSAGE_MAX.toLocaleString('en-US')} characters.`);
    const id = randomUUID();
    const now = Date.now();
    await db.prepare('INSERT INTO support_messages(id, user_id, from_admin, body, created_at) VALUES (?, ?, 1, ?, ?)').run(id, user.id, body, now);
    const message = { id, fromSupport: true, body, createdAt: now, readByUser: false, readBySupport: true };
    await notifyUser(user.id, { type: 'support:message', message });
    response.status(201).json(message);
  });

  /** Conversations with a message the support team hasn't read yet (the admin console's badge). */
  return {
    unanswered: async () => Number((await db.prepare('SELECT count(DISTINCT user_id) AS "count" FROM support_messages WHERE from_admin = 0 AND read_by_admin_at IS NULL').get())?.count ?? 0),
  };
}
