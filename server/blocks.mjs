// Blocking, as on WhatsApp. When A blocks B:
//   - B's messages to A are accepted with one tick but never delivered; B's calls never ring for A.
//   - B no longer sees A's online / last seen, profile photo or status updates (and A no longer sees B's).
//   - A cannot message or call B until A unblocks B.
// Groups both are in are not affected. The list lives here (it follows the account to every device); the app keeps
// its own record of when each block started and ended, to hide what arrived while blocked.
const MAX_BLOCKS = 5000;

export function ensureBlockSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS blocks (
    blocker_id TEXT NOT NULL, blocked_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (blocker_id, blocked_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS blocks_blocked ON blocks(blocked_id)');
}

/**
 * Block lookups for the rest of the server. Each account's own list (whom it blocked) is read once and kept in
 * `cache` (server/memoryCache.mjs; cleared by any write to blocks), so the checks on every message, call and typing
 * event cost no query. Without a cache every check reads the list.
 */
export function createBlocks(db, { cache = null } = {}) {
  const read = async (blockerId) => new Set((await db.prepare('SELECT blocked_id AS "id" FROM blocks WHERE blocker_id = ?').all(blockerId)).map((row) => row.id));
  const blockedBy = (blockerId) => (cache ? cache.remember(blockerId, () => read(blockerId)) : read(blockerId));
  return {
    /** Whether `blockerId` blocked `blockedId`. */
    async has(blockerId, blockedId) {
      if (!blockerId || !blockedId) return false;
      return (await blockedBy(blockerId)).has(blockedId);
    },
    /** Whether either of the two blocked the other. */
    async between(a, b) {
      if (!a || !b) return false;
      return (await blockedBy(a)).has(b) || (await blockedBy(b)).has(a);
    },
    /** Everyone `userId` blocked or was blocked by (for filtering many viewers at once). */
    async relatedTo(userId) {
      const rows = await db.prepare('SELECT blocked_id AS "id" FROM blocks WHERE blocker_id = ? UNION SELECT blocker_id AS "id" FROM blocks WHERE blocked_id = ?').all(userId, userId);
      return new Set(rows.map((row) => row.id));
    },
  };
}

export function registerBlocks({ app, db, requireSession, publicUser, userColumns, notifyUser, onBlockChanged = () => {} }) {
  const prefixed = userColumns.split(',').map((column) => `u.${column.trim()}`).join(', ');

  app.get('/api/v1/blocks', requireSession, async (request, response) => {
    const rows = await db.prepare(`SELECT ${prefixed}, b.created_at AS "blockedAt" FROM blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.blocker_id = ? ORDER BY b.created_at DESC LIMIT ?`).all(request.session.user_id, MAX_BLOCKS);
    response.json(rows.map((row) => ({ ...publicUser(row), blockedAt: Number(row.blockedAt) })));
  });

  app.put('/api/v1/blocks/:userId', requireSession, async (request, response) => {
    const blockerId = request.session.user_id;
    const blockedId = request.params.userId;
    if (blockedId === blockerId) return response.status(400).json({ error: 'You can’t block yourself.' });
    if (!(await db.prepare('SELECT 1 FROM users WHERE id = ?').get(blockedId))) return response.status(404).json({ error: 'No such account.' });
    const count = Number((await db.prepare('SELECT count(*) AS "count" FROM blocks WHERE blocker_id = ?').get(blockerId))?.count ?? 0);
    if (count >= MAX_BLOCKS) return response.status(409).json({ error: 'Your block list is full.' });
    const at = Date.now();
    await db.prepare('INSERT INTO blocks(blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(blockerId, blockedId, at);
    // Every device of the blocker updates its list; the blocked person is not told.
    await notifyUser(blockerId, { type: 'block:changed', userId: blockedId, blocked: true, at });
    await onBlockChanged(blockerId, blockedId, true);
    response.status(204).end();
  });

  app.delete('/api/v1/blocks/:userId', requireSession, async (request, response) => {
    const blockerId = request.session.user_id;
    const blockedId = request.params.userId;
    const at = Date.now();
    await db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(blockerId, blockedId);
    await notifyUser(blockerId, { type: 'block:changed', userId: blockedId, blocked: false, at });
    await onBlockChanged(blockerId, blockedId, false);
    response.status(204).end();
  });
}
