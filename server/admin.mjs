// The Help Center, reports about people, and the admin console (server side).
//
//   Help Center   public articles by category (GET /api/v1/help…); admins write and publish them.
//   Reports       anyone can report a person (POST /api/v1/users/:id/report); group reports already exist.
//   Admin         accounts with users.is_admin: statistics, user search, suspend/restore, review reports,
//                 edit the Help Center. Admin routes answer 404 to everyone else (they are not advertised).
// Messages stay end-to-end encrypted: nothing here reads or returns message content.
import { randomUUID } from 'node:crypto';

export const HELP_CATEGORIES = ['getting-started', 'chats', 'calls', 'groups-communities', 'privacy-security', 'account', 'business'];
export const REPORT_REASONS = ['spam', 'harassment', 'impersonation', 'scam', 'inappropriate', 'other'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+){0,12}$/;

// Starter articles (written for Hidden Messenger), inserted once when the table is empty.
export const STARTER_ARTICLES = [
  ['create-account', 'getting-started', 'Create your account', 'Hidden Messenger needs no phone number and no email. Pick a username, your date of birth and a password, and you are in.\n\nYour username is how people find you. You can change your display name and photo later under Settings › Profile.'],
  ['install-android', 'getting-started', 'Install the Android app', 'Download the APK from the Download page and open it. If Android asks, allow installing apps from your browser.\n\nThe app keeps its code inside the APK, so it never loads code from a website. Sign in with the same username and password you use on the web.'],
  ['end-to-end-encryption', 'privacy-security', 'How end-to-end encryption works', 'Messages, photos, voice notes, reactions, poll votes and statuses are locked on your phone with keys that only the people in the chat have. The server stores and passes on locked data it cannot read.\n\nTo check a chat, open the contact’s info › Encryption and compare the 60-digit security code with theirs. If both show the same numbers, nobody is in between.'],
  ['two-step-verification', 'privacy-security', 'Turn on two-step verification', 'Go to Settings › Account › Two-step verification and choose a 6-digit PIN. You will be asked for it when you sign in on a new device. Hidden Messenger reminds you of it from time to time so you do not forget it.'],
  ['backup-restore', 'chats', 'Back up and restore your chats', 'Open Tools › Chat backup, choose a password and save the encrypted file. To restore, open the same screen on the new device, pick the file and type the password. Only that password can open the backup.'],
  ['group-admin', 'groups-communities', 'Manage a group as an admin', 'Open the group › info › Settings. You can make other members admins, decide who may send messages or edit group info, share an invite link, and approve people who ask to join.'],
  ['report-and-block', 'privacy-security', 'Report or block someone', 'Open the chat › contact info and choose Block or Report. A report goes to the Hidden Messenger team with the reason you pick. They can suspend accounts that break the rules; they cannot read your messages.'],
];

export function ensureAdminSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS help_articles (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, category TEXT NOT NULL, title TEXT NOT NULL,
    body TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL, updated_by TEXT)`);
  db.exec(`CREATE TABLE IF NOT EXISTS user_reports (id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, reported_id TEXT NOT NULL, reason TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open', created_at INTEGER NOT NULL, resolved_at INTEGER, resolved_by TEXT)`);
  const users = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
  if (!users.has('is_admin')) db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
  if (!users.has('suspended_at')) db.exec('ALTER TABLE users ADD COLUMN suspended_at INTEGER');
  const groupReports = new Set(db.prepare('PRAGMA table_info(group_reports)').all().map((column) => column.name));
  if (groupReports.size && !groupReports.has('status')) db.exec("ALTER TABLE group_reports ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
}

const clean = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
const day = 24 * 60 * 60 * 1000;

export function registerAdmin({ app, db, requireSession, requireAdmin, publicUser, userColumns, closeUserSessions, pushEnabled = () => false, dataDirectoryBytes = async () => null, mediaFileExists = async () => true, onlineNow = () => 0, supportUnanswered = async () => 0 }) {
  const fail = (response, status, error) => response.status(status).json({ error });

  // The starter Help Center is set up once, at start-up.
  const seeded = (async () => {
    const count = Number((await db.prepare('SELECT count(*) AS "count" FROM help_articles').get())?.count ?? 0);
    if (!count) {
      for (const [slug, category, title, body] of STARTER_ARTICLES) {
        await db.prepare('INSERT INTO help_articles(id, slug, category, title, body, published, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT DO NOTHING')
          .run(randomUUID(), slug, category, title, body, Date.now());
      }
    }
  })().catch((error) => console.error('Admin setup failed:', error.message));

  // Admin routes live under /api/admin/v1 and take only an admin session (server/adminAuth.mjs), never a chat
  // session: chat accounts have no admin powers.

  /** Sign-in and device linking refuse suspended accounts (index.mjs calls this before issuing a session). */
  async function suspended(userId) {
    return Boolean((await db.prepare('SELECT suspended_at AS "at" FROM users WHERE id = ?').get(userId))?.at);
  }

  // --- Help Center (public) ---
  const presentArticle = (row) => ({ id: row.id, slug: row.slug, category: row.category, title: row.title, body: row.body, published: Boolean(Number(row.published)), updatedAt: Number(row.updatedAt) });
  const articleColumns = 'id, slug, category, title, body, published, updated_at AS "updatedAt"';

  app.get('/api/v1/help', async (request, response) => {
    await seeded;
    const query = clean(String(request.query.q ?? ''), 80).toLowerCase();
    const rows = await db.prepare(`SELECT ${articleColumns} FROM help_articles WHERE published = 1 ORDER BY category, title`).all();
    const found = query ? rows.filter((row) => `${row.title} ${row.body}`.toLowerCase().includes(query)) : rows;
    response.set('Cache-Control', 'public, max-age=60');
    response.json({ categories: HELP_CATEGORIES, articles: found.map((row) => ({ ...presentArticle(row), body: undefined, summary: row.body.split('\n')[0].slice(0, 160) })) });
  });

  app.get('/api/v1/help/:slug', async (request, response) => {
    await seeded;
    const row = await db.prepare(`SELECT ${articleColumns} FROM help_articles WHERE slug = ? AND published = 1`).get(request.params.slug);
    if (!row) return fail(response, 404, 'Article not found.');
    response.json(presentArticle(row));
  });

  // --- Reports about people ---
  app.post('/api/v1/users/:userId/report', requireSession, async (request, response) => {
    const reporter = request.session.user_id;
    const reported = request.params.userId;
    const reason = REPORT_REASONS.includes(request.body?.reason) ? request.body.reason : null;
    if (!reason) return fail(response, 400, 'Choose a reason.');
    if (reported === reporter || !await db.prepare('SELECT 1 FROM users WHERE id = ?').get(reported)) return fail(response, 404, 'User not found.');
    const recent = await db.prepare("SELECT 1 FROM user_reports WHERE reporter_id = ? AND reported_id = ? AND status = 'open'").get(reporter, reported);
    if (!recent) {
      await db.prepare('INSERT INTO user_reports(id, reporter_id, reported_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), reporter, reported, reason, clean(request.body?.details, 500), Date.now());
    }
    response.status(201).json({ reported: true });
  });

  // --- Admin: overview ---

  // --- Admin: stored media integrity -------------------------------------------------------------------------
  // Which attachment records have lost their file on disk (for example files saved inside an earlier release
  // before uploads moved to the persistent data directory). Reports counts and dates only, never names.
  const MEDIA_SCAN_LIMIT = 10_000;
  async function scanMedia() {
    const rows = await db.prepare('SELECT id, disk_name AS "diskName", created_at AS "createdAt" FROM media ORDER BY created_at DESC LIMIT ?').all(MEDIA_SCAN_LIMIT);
    const missing = [];
    for (const row of rows) if (!(await mediaFileExists(row.diskName))) missing.push(row);
    const dates = missing.map((row) => Number(row.createdAt));
    const present = rows.filter((row) => !missing.includes(row)).map((row) => Number(row.createdAt));
    return {
      scan: { checked: rows.length, missing: missing.length, complete: rows.length < MEDIA_SCAN_LIMIT,
        oldestMissingAt: dates.length ? Math.min(...dates) : null, newestMissingAt: dates.length ? Math.max(...dates) : null,
        newestPresentAt: present.length ? Math.max(...present) : null },
      missing,
    };
  }
  app.get('/api/admin/v1/media-integrity', requireAdmin, async (_request, response) => {
    response.json((await scanMedia()).scan);
  });
  // Removes the records of attachments whose file is gone, so chats show "no longer available" at once and the
  // health check reflects only real problems. Files that exist are never touched.
  app.post('/api/admin/v1/media-integrity/clean', requireAdmin, async (_request, response) => {
    const { missing } = await scanMedia();
    for (const row of missing) await db.prepare('DELETE FROM media WHERE id = ?').run(row.id);
    response.json({ removed: missing.length });
  });

  // Live tickers for the console header (polled every few seconds). Counts only: no names, no content.
  app.get('/api/admin/v1/live', requireAdmin, async (_request, response) => {
    const now = Date.now();
    const count = async (sql, ...values) => Number((await db.prepare(sql).get(...values))?.count ?? 0);
    const startOfDay = new Date(now); startOfDay.setUTCHours(0, 0, 0, 0);
    const createdIso = typeof (await db.prepare('SELECT created_at AS "at" FROM users LIMIT 1').get())?.at === 'string';
    response.json({
      at: now,
      online: onlineNow(),
      activeLastHour: await count('SELECT count(DISTINCT user_id) AS "count" FROM sessions WHERE last_active_at >= ?', now - 60 * 60 * 1000),
      messagesLastHour: await count('SELECT count(*) AS "count" FROM messages WHERE created_at >= ?', new Date(now - 60 * 60 * 1000).toISOString()),
      signupsToday: await count('SELECT count(*) AS "count" FROM users WHERE created_at >= ?', createdIso ? startOfDay.toISOString() : startOfDay.getTime()),
      openReports: await count("SELECT count(*) AS \"count\" FROM user_reports WHERE status = 'open'") + await count("SELECT count(*) AS \"count\" FROM group_reports WHERE status = 'open'"),
      pendingVerifications: await count("SELECT count(*) AS \"count\" FROM verification_tickets WHERE status = 'pending'"),
      openSupport: await supportUnanswered(),
    });
  });

  app.get('/api/admin/v1/stats', requireAdmin, async (_request, response) => {
    const now = Date.now();
    const count = async (sql, ...values) => Number((await db.prepare(sql).get(...values))?.count ?? 0);
    const series = async (table, column, iso) => {
      const out = [];
      for (let index = 13; index >= 0; index -= 1) {
        const start = new Date(now - index * day);
        start.setUTCHours(0, 0, 0, 0);
        const from = start.getTime();
        const to = from + day;
        const value = iso
          ? await count(`SELECT count(*) AS "count" FROM ${table} WHERE ${column} >= ? AND ${column} < ?`, new Date(from).toISOString(), new Date(to).toISOString())
          : await count(`SELECT count(*) AS "count" FROM ${table} WHERE ${column} >= ? AND ${column} < ?`, from, to);
        out.push({ day: new Date(from).toISOString().slice(0, 10), value });
      }
      return out;
    };
    const activeSince = async (since) => count('SELECT count(DISTINCT user_id) AS "count" FROM sessions WHERE last_active_at >= ?', since);
    response.json({
      users: await count('SELECT count(*) AS "count" FROM users'),
      suspended: await count('SELECT count(*) AS "count" FROM users WHERE suspended_at IS NOT NULL'),
      activeToday: await activeSince(now - day),
      activeWeek: await activeSince(now - 7 * day),
      groups: await count('SELECT count(*) AS "count" FROM groups'),
      channels: await count('SELECT count(*) AS "count" FROM channels'),
      openReports: await count("SELECT count(*) AS \"count\" FROM user_reports WHERE status = 'open'") + await count("SELECT count(*) AS \"count\" FROM group_reports WHERE status = 'open'"),
      encryptedDevices: await count('SELECT count(*) AS "count" FROM e2e_devices'),
      verifiedBusinesses: await count('SELECT count(*) AS "count" FROM verified_accounts'),
      verifiedChannels: await count('SELECT count(*) AS "count" FROM verified_channels'),
      pendingVerifications: await count("SELECT count(*) AS \"count\" FROM verification_tickets WHERE status = 'pending'"),
      mediaBytes: Number((await db.prepare('SELECT COALESCE(sum(byte_size), 0) AS "bytes" FROM media').get())?.bytes ?? 0),
      diskBytes: await dataDirectoryBytes(),
      push: pushEnabled(),
      signups: await series('users', 'created_at', typeof (await db.prepare('SELECT created_at AS "at" FROM users LIMIT 1').get())?.at === 'string'),
      messages: await series('messages', 'created_at', true),
    });
  });

  // --- Admin: users ---
  app.get('/api/admin/v1/users', requireAdmin, async (request, response) => {
    const query = clean(String(request.query.q ?? ''), 60).toLowerCase().replace(/^@/, '');
    const rows = await db.prepare(`SELECT ${userColumns}, created_at AS "createdAt", last_seen_at AS "lastSeenAt", suspended_at AS "suspendedAt",
        (SELECT count(*) FROM user_reports r WHERE r.reported_id = users.id AND r.status = 'open') AS "openReports"
      FROM users WHERE (lower(username) LIKE ? OR lower(name) LIKE ?) ORDER BY created_at DESC LIMIT 50`).all(`%${query}%`, `%${query}%`);
    response.json(rows.map((row) => ({
      ...publicUser(row),
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt ? Number(row.lastSeenAt) : null,
      suspendedAt: row.suspendedAt ? Number(row.suspendedAt) : null,
      openReports: Number(row.openReports),
    })));
  });

  app.post('/api/admin/v1/users/:userId/:action', requireAdmin, async (request, response) => {
    const { userId, action } = request.params;
    const target = await db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
    if (!target) return fail(response, 404, 'User not found.');
    if (action === 'suspend') {
      await db.prepare('UPDATE users SET suspended_at = ? WHERE id = ?').run(Date.now(), userId);
      await closeUserSessions(userId, 'This account was suspended');
    } else if (action === 'restore') {
      await db.prepare('UPDATE users SET suspended_at = NULL WHERE id = ?').run(userId);
    } else {
      return fail(response, 400, 'Unknown action.');
    }
    response.json({ ok: true });
  });

  // --- Admin: reports (people and groups) ---
  app.get('/api/admin/v1/reports', requireAdmin, async (request, response) => {
    const status = request.query.status === 'closed' ? 'closed' : 'open';
    const people = await db.prepare(`SELECT r.id, r.reason, r.details, r.created_at AS "createdAt", r.status,
        r.reported_id AS "targetId", u.username AS "targetName", u.suspended_at AS "targetSuspended", rp.username AS "reporterName"
      FROM user_reports r JOIN users u ON u.id = r.reported_id JOIN users rp ON rp.id = r.reporter_id
      WHERE ${status === 'open' ? "r.status = 'open'" : "r.status <> 'open'"} ORDER BY r.created_at DESC LIMIT 100`).all();
    const groups = await db.prepare(`SELECT r.id, r.reason, r.created_at AS "createdAt", r.status, r.group_id AS "targetId", g.name AS "targetName", rp.username AS "reporterName"
      FROM group_reports r JOIN groups g ON g.id = r.group_id JOIN users rp ON rp.id = r.reporter_id
      WHERE ${status === 'open' ? "r.status = 'open'" : "r.status <> 'open'"} ORDER BY r.created_at DESC LIMIT 100`).all();
    response.json([
      ...people.map((row) => ({ ...row, kind: 'user', createdAt: Number(row.createdAt), targetSuspended: Boolean(row.targetSuspended) })),
      ...groups.map((row) => ({ ...row, kind: 'group', details: '', createdAt: Number(row.createdAt) })),
    ].sort((left, right) => right.createdAt - left.createdAt));
  });

  app.post('/api/admin/v1/reports/:kind/:id', requireAdmin, async (request, response) => {
    const status = ['resolved', 'dismissed'].includes(request.body?.status) ? request.body.status : null;
    if (!status) return fail(response, 400, 'Resolve or dismiss the report.');
    const table = request.params.kind === 'group' ? 'group_reports' : request.params.kind === 'user' ? 'user_reports' : null;
    if (!table) return fail(response, 404, 'Report not found.');
    const updated = table === 'user_reports'
      ? await db.prepare('UPDATE user_reports SET status = ?, resolved_at = ?, resolved_by = ? WHERE id = ? RETURNING id').get(status, Date.now(), request.admin.actor, request.params.id)
      : await db.prepare('UPDATE group_reports SET status = ? WHERE id = ? RETURNING id').get(status, request.params.id);
    if (!updated) return fail(response, 404, 'Report not found.');
    response.json({ ok: true });
  });

  // --- Admin: Help Center editor ---
  app.get('/api/admin/v1/help', requireAdmin, async (_request, response) => {
    const rows = await db.prepare(`SELECT ${articleColumns} FROM help_articles ORDER BY category, title`).all();
    response.json(rows.map(presentArticle));
  });

  function readArticle(body) {
    const slug = clean(body?.slug, 80).toLowerCase();
    const title = clean(body?.title, 140);
    const text = clean(body?.body, 20_000);
    if (!SLUG.test(slug) || !title || !text || !HELP_CATEGORIES.includes(body?.category)) return null;
    return { slug, title, body: text, category: body.category, published: body?.published !== false };
  }

  app.post('/api/admin/v1/help', requireAdmin, async (request, response) => {
    const article = readArticle(request.body);
    if (!article) return fail(response, 400, 'Give a title, text, a category and a web address (lower-case words joined by dashes).');
    if (await db.prepare('SELECT 1 FROM help_articles WHERE slug = ?').get(article.slug)) return fail(response, 409, 'Another article already uses that web address.');
    const id = randomUUID();
    await db.prepare('INSERT INTO help_articles(id, slug, category, title, body, published, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, article.slug, article.category, article.title, article.body, article.published ? 1 : 0, Date.now(), request.admin.actor);
    response.status(201).json(presentArticle(await db.prepare(`SELECT ${articleColumns} FROM help_articles WHERE id = ?`).get(id)));
  });

  app.put('/api/admin/v1/help/:id', requireAdmin, async (request, response) => {
    const article = readArticle(request.body);
    if (!article) return fail(response, 400, 'Give a title, text, a category and a web address (lower-case words joined by dashes).');
    const clash = await db.prepare('SELECT id FROM help_articles WHERE slug = ? AND id <> ?').get(article.slug, request.params.id);
    if (clash) return fail(response, 409, 'Another article already uses that web address.');
    const updated = await db.prepare(`UPDATE help_articles SET slug = ?, category = ?, title = ?, body = ?, published = ?, updated_at = ?, updated_by = ? WHERE id = ? RETURNING id`)
      .get(article.slug, article.category, article.title, article.body, article.published ? 1 : 0, Date.now(), request.admin.actor, request.params.id);
    if (!updated) return fail(response, 404, 'Article not found.');
    response.json(presentArticle(await db.prepare(`SELECT ${articleColumns} FROM help_articles WHERE id = ?`).get(request.params.id)));
  });

  app.delete('/api/admin/v1/help/:id', requireAdmin, async (request, response) => {
    const removed = await db.prepare('DELETE FROM help_articles WHERE id = ? RETURNING id').get(request.params.id);
    if (!removed) return fail(response, 404, 'Article not found.');
    response.status(204).end();
  });

  return { suspended, ready: () => seeded };
}
