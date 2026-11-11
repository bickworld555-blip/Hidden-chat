// Verification badges for businesses and channels. A business asks in Settings › Verified; a channel owner asks
// from the channel's page. Every request is a ticket with its own ID (VR-XXXXXX). The admin console reviews
// tickets, approves or rejects them (with an optional reason), and can remove a badge later. Approved accounts
// and channels carry `verified: true` on their public records. No payment is involved.
// Postgres: supabase/migrations/017_verified.sql and 018_admin_dashboard.sql. SQLite: ensureVerificationSchema.
import { randomInt } from 'node:crypto';

const NOTE_LIMIT = 500;
const KINDS = ['business', 'channel'];
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

/** A short, unambiguous request ID: VR- and six characters (no 0/O, 1/I/L). */
export function newRequestId() {
  let id = 'VR-';
  for (let index = 0; index < 6; index += 1) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return id;
}

export function ensureVerificationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verified_accounts (user_id TEXT PRIMARY KEY, verified_at INTEGER NOT NULL, granted_by TEXT);
    CREATE TABLE IF NOT EXISTS verification_requests (
      user_id TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, decided_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS verified_channels (channel_id TEXT PRIMARY KEY, verified_at INTEGER NOT NULL, granted_by TEXT);
    CREATE TABLE IF NOT EXISTS verification_tickets (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL, requester_id TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL,
      decided_at INTEGER, decided_by TEXT, decision_note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS verification_tickets_queue ON verification_tickets(kind, status, created_at);
    CREATE INDEX IF NOT EXISTS verification_tickets_subject ON verification_tickets(kind, subject_id, created_at);
  `);
  // Requests made before tickets existed become tickets once (Postgres does this in 018_admin_dashboard.sql).
  const legacy = db.prepare(`SELECT r.user_id AS "userId", r.note, r.status, r.created_at AS "createdAt", r.decided_at AS "decidedAt" FROM verification_requests r
    WHERE NOT EXISTS (SELECT 1 FROM verification_tickets t WHERE t.kind = 'business' AND t.subject_id = r.user_id)`).all();
  for (const row of legacy) {
    db.prepare('INSERT INTO verification_tickets(id, kind, subject_id, requester_id, note, status, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(newRequestId(), 'business', row.userId, row.userId, row.note ?? '', row.status === 'declined' ? 'rejected' : row.status, row.createdAt, row.decidedAt ?? null);
  }
}

/** An in-memory set of verified ids for one table, so public records say who is verified without a join. */
function createVerifiedSet(db, table, column) {
  const ids = new Set();
  const ready = (async () => {
    for (const row of await db.prepare(`SELECT ${column} AS "id" FROM ${table}`).all()) ids.add(row.id);
  })().catch((error) => console.error(`Could not load ${table}:`, error.message));
  return { ready, has: (id) => ids.has(id), add: (id) => ids.add(id), remove: (id) => ids.delete(id), size: () => ids.size };
}
export const createVerifiedAccounts = (db) => createVerifiedSet(db, 'verified_accounts', 'user_id');
export const createVerifiedChannels = (db) => createVerifiedSet(db, 'verified_channels', 'channel_id');

export function registerVerification({ app, db, requireSession, requireAdmin, verified, verifiedChannels, publicUser, userColumns, now = () => Date.now() }) {
  const fail = (response, status, error) => response.status(status).json({ error });
  const cleanNote = (value) => (typeof value === 'string' ? value.trim().slice(0, NOTE_LIMIT) : '');
  const setFor = (kind) => (kind === 'channel' ? verifiedChannels : verified);
  const grants = { business: ['verified_accounts', 'user_id'], channel: ['verified_channels', 'channel_id'] };

  const presentTicket = (row) => ({
    requestId: row.id, kind: row.kind, status: row.status, note: row.note, requestedAt: Number(row.createdAt),
    decidedAt: row.decidedAt ? Number(row.decidedAt) : null, decisionNote: row.decisionNote || '',
  });
  const latestTicket = (kind, subjectId) => db.prepare(`SELECT id, kind, status, note, created_at AS "createdAt", decided_at AS "decidedAt", decision_note AS "decisionNote"
    FROM verification_tickets WHERE kind = ? AND subject_id = ? AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 1`).get(kind, subjectId);

  async function stateFor(kind, subjectId) {
    const set = setFor(kind);
    await set.ready;
    const ticket = await latestTicket(kind, subjectId);
    if (set.has(subjectId)) {
      const [table, column] = grants[kind];
      const row = await db.prepare(`SELECT verified_at AS "at" FROM ${table} WHERE ${column} = ?`).get(subjectId);
      return { status: 'verified', verifiedAt: Number(row?.at ?? 0), ...(ticket ? { requestId: ticket.id } : {}) };
    }
    if (!ticket || ticket.status === 'approved') return { status: 'none' };
    return presentTicket(ticket);
  }

  async function openTicket(kind, subjectId, requesterId, note) {
    const current = await stateFor(kind, subjectId);
    if (current.status === 'verified') return { error: [409, kind === 'channel' ? 'This channel is already verified.' : 'Your account is already verified.'] };
    if (current.status === 'pending') return { error: [409, 'A request is already waiting for review.'] };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = newRequestId();
      if (await db.prepare('SELECT 1 FROM verification_tickets WHERE id = ?').get(id)) continue;
      await db.prepare("INSERT INTO verification_tickets(id, kind, subject_id, requester_id, note, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
        .run(id, kind, subjectId, requesterId, note, now());
      return { state: await stateFor(kind, subjectId) };
    }
    return { error: [503, 'Try again.'] };
  }
  const cancelTicket = (kind, subjectId) => db.prepare("UPDATE verification_tickets SET status = 'cancelled', decided_at = ? WHERE kind = ? AND subject_id = ? AND status = 'pending'").run(now(), kind, subjectId);

  // --- Businesses (your own account) ---
  app.get('/api/v1/me/verification', requireSession, async (request, response) => {
    response.json(await stateFor('business', request.session.user_id));
  });
  // A business profile with a category is required: the badge says "this is a business".
  app.post('/api/v1/me/verification', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const profile = await db.prepare('SELECT category FROM business_profiles WHERE user_id = ?').get(userId);
    if (!profile || !String(profile.category ?? '').trim()) return fail(response, 400, 'Add your business category in Tools › Business profile first.');
    const result = await openTicket('business', userId, userId, cleanNote(request.body?.note));
    if (result.error) return fail(response, ...result.error);
    response.status(201).json(result.state);
  });
  app.delete('/api/v1/me/verification', requireSession, async (request, response) => {
    await cancelTicket('business', request.session.user_id);
    response.json(await stateFor('business', request.session.user_id));
  });

  // --- Channels (the owner asks) ---
  async function ownedChannel(request, response) {
    const channel = await db.prepare('SELECT id, owner_id AS "ownerId", description FROM channels WHERE id = ?').get(request.params.id);
    if (!channel) { fail(response, 404, 'Channel not found.'); return null; }
    if (channel.ownerId !== request.session.user_id) { fail(response, 403, 'Only the channel’s owner can ask for verification.'); return null; }
    return channel;
  }
  app.get('/api/v1/channels/:id/verification', requireSession, async (request, response) => {
    const channel = await ownedChannel(request, response);
    if (channel) response.json(await stateFor('channel', channel.id));
  });
  app.post('/api/v1/channels/:id/verification', requireSession, async (request, response) => {
    const channel = await ownedChannel(request, response);
    if (!channel) return;
    if (!String(channel.description ?? '').trim()) return fail(response, 400, 'Add a channel description first.');
    const result = await openTicket('channel', channel.id, request.session.user_id, cleanNote(request.body?.note));
    if (result.error) return fail(response, ...result.error);
    response.status(201).json(result.state);
  });
  app.delete('/api/v1/channels/:id/verification', requireSession, async (request, response) => {
    const channel = await ownedChannel(request, response);
    if (!channel) return;
    await cancelTicket('channel', channel.id);
    response.json(await stateFor('channel', channel.id));
  });

  // --- Admin ---
  async function grant(kind, subjectId, actor) {
    const [table, column] = grants[kind];
    await db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(subjectId);
    await db.prepare(`INSERT INTO ${table}(${column}, verified_at, granted_by) VALUES (?, ?, ?)`).run(subjectId, now(), actor);
    setFor(kind).add(subjectId);
  }
  async function revoke(kind, subjectId) {
    const [table, column] = grants[kind];
    await db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(subjectId);
    setFor(kind).remove(subjectId);
  }

  // The queue: business and channel requests, each with its ID, what it is about and who asked. Business
  // profile and channel details are public information; nothing private (chats, media) is included.
  app.get('/api/admin/v1/verification', requireAdmin, async (request, response) => {
    const kind = KINDS.includes(request.query.kind) ? request.query.kind : 'business';
    const status = ['pending', 'approved', 'rejected', 'cancelled'].includes(request.query.status) ? request.query.status : 'pending';
    const query = String(request.query.q ?? '').trim().toUpperCase().slice(0, 20);
    const rows = await db.prepare(`SELECT t.id, t.kind, t.subject_id AS "subjectId", t.status, t.note, t.created_at AS "createdAt", t.decided_at AS "decidedAt",
        t.decision_note AS "decisionNote", t.decided_by AS "decidedBy", r.username AS "requester"
      FROM verification_tickets t LEFT JOIN users r ON r.id = t.requester_id
      WHERE t.kind = ? AND t.status = ?${query ? ' AND upper(t.id) LIKE ?' : ''} ORDER BY t.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT 200`)
      .all(...[kind, status, ...(query ? [`%${query}%`] : [])]);
    const items = [];
    for (const row of rows) {
      let subject = null;
      if (kind === 'business') {
        const user = await db.prepare(`SELECT ${userColumns} FROM users WHERE id = ?`).get(row.subjectId);
        const profile = await db.prepare('SELECT category, description, website FROM business_profiles WHERE user_id = ?').get(row.subjectId);
        if (user) subject = { ...publicUser(user), category: profile?.category ?? '', description: profile?.description ?? '', website: profile?.website ?? '' };
      } else {
        const channel = await db.prepare(`SELECT c.id, c.name, c.description, c.category, u.username AS "owner",
          (SELECT count(*) FROM channel_followers f WHERE f.channel_id = c.id) AS "followers" FROM channels c LEFT JOIN users u ON u.id = c.owner_id WHERE c.id = ?`).get(row.subjectId);
        if (channel) subject = { ...channel, followers: Number(channel.followers), verified: verifiedChannels.has(channel.id) };
      }
      items.push({ ...presentTicket({ ...row }), subjectId: row.subjectId, requester: row.requester ?? null, decidedBy: row.decidedBy ?? null, subject });
    }
    response.json(items);
  });

  app.get('/api/admin/v1/verification/summary', requireAdmin, async (_request, response) => {
    const rows = await db.prepare('SELECT kind, status, count(*) AS "count" FROM verification_tickets GROUP BY kind, status').all();
    const summary = { business: { pending: 0, approved: 0, rejected: 0 }, channel: { pending: 0, approved: 0, rejected: 0 } };
    for (const row of rows) if (summary[row.kind] && row.status in summary[row.kind]) summary[row.kind][row.status] = Number(row.count);
    await verified.ready; await verifiedChannels.ready;
    response.json({ ...summary, verifiedBusinesses: verified.size(), verifiedChannels: verifiedChannels.size() });
  });

  app.post('/api/admin/v1/verification/:requestId/decision', requireAdmin, async (request, response) => {
    const ticket = await db.prepare('SELECT id, kind, subject_id AS "subjectId", status FROM verification_tickets WHERE id = ?').get(request.params.requestId);
    if (!ticket) return fail(response, 404, 'No such request.');
    if (ticket.status !== 'pending') return fail(response, 409, `This request was already ${ticket.status}.`);
    const decision = request.body?.decision;
    if (decision !== 'approve' && decision !== 'reject') return fail(response, 400, 'Choose approve or reject.');
    const note = cleanNote(request.body?.note);
    await db.prepare('UPDATE verification_tickets SET status = ?, decided_at = ?, decided_by = ?, decision_note = ? WHERE id = ?')
      .run(decision === 'approve' ? 'approved' : 'rejected', now(), request.admin.actor, note, ticket.id);
    if (decision === 'approve') await grant(ticket.kind, ticket.subjectId, request.admin.actor);
    response.json({ requestId: ticket.id, status: decision === 'approve' ? 'approved' : 'rejected' });
  });

  // Remove (or directly grant) a badge.
  app.put('/api/admin/v1/users/:id/verified', requireAdmin, async (request, response) => {
    if (!await db.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').get(request.params.id)) return fail(response, 404, 'No such account.');
    if (request.body?.verified === true) await grant('business', request.params.id, request.admin.actor);
    else await revoke('business', request.params.id);
    response.json(await stateFor('business', request.params.id));
  });
  app.put('/api/admin/v1/channels/:id/verified', requireAdmin, async (request, response) => {
    if (!await db.prepare('SELECT id FROM channels WHERE id = ?').get(request.params.id)) return fail(response, 404, 'No such channel.');
    if (request.body?.verified === true) await grant('channel', request.params.id, request.admin.actor);
    else await revoke('channel', request.params.id);
    response.json(await stateFor('channel', request.params.id));
  });
  app.get('/api/admin/v1/verified', requireAdmin, async (request, response) => {
    const kind = KINDS.includes(request.query.kind) ? request.query.kind : 'business';
    const rows = kind === 'business'
      ? await db.prepare(`SELECT ${userColumns}, v.verified_at AS "verifiedAt" FROM verified_accounts v JOIN users ON users.id = v.user_id ORDER BY v.verified_at DESC LIMIT 500`).all()
      : await db.prepare('SELECT c.id, c.name, v.verified_at AS "verifiedAt" FROM verified_channels v JOIN channels c ON c.id = v.channel_id ORDER BY v.verified_at DESC LIMIT 500').all();
    response.json(rows.map((row) => (kind === 'business' ? { user: publicUser(row), verifiedAt: Number(row.verifiedAt) } : { channel: { id: row.id, name: row.name }, verifiedAt: Number(row.verifiedAt) })));
  });
}
