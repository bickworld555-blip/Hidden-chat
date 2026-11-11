// Verified business badge. A business asks for verification from Settings › Verified; an admin approves or
// declines it in the admin console. Approved accounts carry `verified: true` on every public user record, and
// the apps show our own badge next to the name. No payment is involved.
// Postgres: supabase/migrations/017_verified.sql. SQLite: ensureVerificationSchema below.

const NOTE_LIMIT = 500;

export function ensureVerificationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verified_accounts (user_id TEXT PRIMARY KEY, verified_at INTEGER NOT NULL, granted_by TEXT);
    CREATE TABLE IF NOT EXISTS verification_requests (
      user_id TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL, decided_at INTEGER
    );
  `);
}

/**
 * The set of verified account ids, kept in memory so public user records can say who is verified without
 * every user query joining another table. Loaded at start-up and updated by the routes below.
 */
export function createVerifiedAccounts(db) {
  const ids = new Set();
  const ready = (async () => {
    for (const row of await db.prepare('SELECT user_id AS "userId" FROM verified_accounts').all()) ids.add(row.userId);
  })().catch((error) => console.error('Could not load verified accounts:', error.message));
  return { ready, has: (userId) => ids.has(userId), add: (userId) => ids.add(userId), remove: (userId) => ids.delete(userId) };
}

export function registerVerification({ app, db, requireSession, isAdmin, verified, publicUser, userColumns, now = () => Date.now() }) {
  const fail = (response, status, error) => response.status(status).json({ error });
  async function requireAdmin(request, response, next) {
    if (!await isAdmin(request.session.user_id)) return fail(response, 404, 'Not found.');
    return next();
  }
  async function stateFor(userId) {
    await verified.ready;
    if (verified.has(userId)) {
      const row = await db.prepare('SELECT verified_at AS "at" FROM verified_accounts WHERE user_id = ?').get(userId);
      return { status: 'verified', verifiedAt: Number(row?.at ?? 0) };
    }
    const request = await db.prepare('SELECT status, note, created_at AS "createdAt", decided_at AS "decidedAt" FROM verification_requests WHERE user_id = ?').get(userId);
    if (!request) return { status: 'none' };
    return { status: request.status, note: request.note, requestedAt: Number(request.createdAt), decidedAt: request.decidedAt ? Number(request.decidedAt) : null };
  }

  app.get('/api/v1/me/verification', requireSession, async (request, response) => {
    response.json(await stateFor(request.session.user_id));
  });

  // Ask (or ask again after a decline). A business profile is required: the badge says "this is a business".
  app.post('/api/v1/me/verification', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const current = await stateFor(userId);
    if (current.status === 'verified') return fail(response, 409, 'Your account is already verified.');
    if (current.status === 'pending') return fail(response, 409, 'Your request is already waiting for review.');
    const note = typeof request.body?.note === 'string' ? request.body.note.trim().slice(0, NOTE_LIMIT) : '';
    const profile = await db.prepare('SELECT category, description FROM business_profiles WHERE user_id = ?').get(userId);
    if (!profile || !String(profile.category ?? '').trim()) return fail(response, 400, 'Add your business category in Tools › Business profile first.');
    await db.prepare('DELETE FROM verification_requests WHERE user_id = ?').run(userId);
    await db.prepare("INSERT INTO verification_requests(user_id, note, status, created_at) VALUES (?, ?, 'pending', ?)").run(userId, note, now());
    response.status(201).json(await stateFor(userId));
  });

  app.delete('/api/v1/me/verification', requireSession, async (request, response) => {
    await db.prepare("DELETE FROM verification_requests WHERE user_id = ? AND status = 'pending'").run(request.session.user_id);
    response.json(await stateFor(request.session.user_id));
  });

  // --- Admin ---
  app.get('/api/v1/admin/verification', requireSession, requireAdmin, async (_request, response) => {
    const pending = await db.prepare(`SELECT ${userColumns}, r.note AS "note", r.created_at AS "requestedAt"
      FROM verification_requests r JOIN users ON users.id = r.user_id WHERE r.status = 'pending' ORDER BY r.created_at`).all();
    const granted = await db.prepare(`SELECT ${userColumns}, v.verified_at AS "verifiedAt"
      FROM verified_accounts v JOIN users ON users.id = v.user_id ORDER BY v.verified_at DESC LIMIT 200`).all();
    response.json({
      pending: pending.map((row) => ({ user: publicUser(row), note: row.note, requestedAt: Number(row.requestedAt) })),
      verified: granted.map((row) => ({ user: publicUser(row), verifiedAt: Number(row.verifiedAt) })),
    });
  });

  // Grant or remove the badge (approving a request, declining it, or revoking).
  app.put('/api/v1/admin/users/:id/verified', requireSession, requireAdmin, async (request, response) => {
    const userId = request.params.id;
    const exists = await db.prepare('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL').get(userId);
    if (!exists) return fail(response, 404, 'No such account.');
    const on = request.body?.verified === true;
    const at = now();
    if (on) {
      await db.prepare('DELETE FROM verified_accounts WHERE user_id = ?').run(userId);
      await db.prepare('INSERT INTO verified_accounts(user_id, verified_at, granted_by) VALUES (?, ?, ?)').run(userId, at, request.session.user_id);
      await db.prepare("UPDATE verification_requests SET status = 'approved', decided_at = ? WHERE user_id = ?").run(at, userId);
      verified.add(userId);
    } else {
      await db.prepare('DELETE FROM verified_accounts WHERE user_id = ?').run(userId);
      await db.prepare("UPDATE verification_requests SET status = 'declined', decided_at = ? WHERE user_id = ? AND status = 'pending'").run(at, userId);
      verified.remove(userId);
    }
    response.json(await stateFor(userId));
  });
}
