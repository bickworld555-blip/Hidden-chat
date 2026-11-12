// End-to-end encrypted chat backups kept for the account (WhatsApp-style): the phone seals its whole local history
// with a password or a 64-digit recovery key that never leaves it (src/backup.js) and uploads the result here. The
// server keeps one opaque file per account, on disk next to attachments, and hands it back for a restore; it cannot
// open it. A new upload replaces the previous file.
import express from 'express';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_BACKUP_BYTES = 256 * 1024 * 1024;
const FORMAT_PREFIX = '{"format":"hidden-messenger-backup"';
const KDF_LABELS = new Set(['password', 'recovery-key']);

export function registerBackups({ app, db, requireSession, dataDirectory, now = () => Date.now() }) {
  const directory = join(dataDirectory, 'backups');
  // Made when first needed (not at start-up, so a server without backups never touches the folder).
  const ready = () => mkdir(directory, { recursive: true });

  async function current(userId) {
    return db.prepare('SELECT disk_name AS "diskName", byte_size AS "byteSize", kdf, updated_at AS "updatedAt" FROM backups WHERE user_id = ?').get(userId);
  }

  app.get('/api/v1/backup', requireSession, async (request, response) => {
    const row = await current(request.session.user_id);
    response.set('Cache-Control', 'no-store');
    response.json(row ? { exists: true, byteSize: Number(row.byteSize), kdf: row.kdf, updatedAt: Number(row.updatedAt) } : { exists: false });
  });

  app.get('/api/v1/backup/file', requireSession, async (request, response) => {
    const row = await current(request.session.user_id);
    if (!row) return response.status(404).json({ error: 'No backup has been made for this account.' });
    response.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    response.sendFile(row.diskName, { root: directory, dotfiles: 'deny' }, (error) => {
      if (error && !response.headersSent) response.status(410).json({ error: 'The backup file is missing. Make a new backup.' });
    });
  });

  app.put('/api/v1/backup', requireSession, express.raw({ type: () => true, limit: MAX_BACKUP_BYTES }), async (request, response) => {
    const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    // Only a sealed backup file is accepted (the start of its JSON header); its contents stay opaque.
    if (body.length < FORMAT_PREFIX.length || body.subarray(0, FORMAT_PREFIX.length).toString('utf8') !== FORMAT_PREFIX) {
      return response.status(400).json({ error: 'Upload an encrypted Hidden Messenger backup.' });
    }
    const kdf = KDF_LABELS.has(String(request.get('X-Backup-Kdf'))) ? String(request.get('X-Backup-Kdf')) : 'password';
    await ready();
    const userId = request.session.user_id;
    const diskName = `${randomBytes(16).toString('hex')}.hmbackup`;
    const temporary = join(directory, `.${diskName}.part`);
    await writeFile(temporary, body);
    await rename(temporary, join(directory, diskName));
    const previous = await current(userId);
    const at = now();
    await db.prepare(`INSERT INTO backups(user_id, disk_name, byte_size, kdf, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET disk_name = excluded.disk_name, byte_size = excluded.byte_size, kdf = excluded.kdf, updated_at = excluded.updated_at`)
      .run(userId, diskName, body.length, kdf, at);
    if (previous?.diskName) await rm(join(directory, previous.diskName), { force: true });
    response.json({ exists: true, byteSize: body.length, kdf, updatedAt: at });
  });

  app.delete('/api/v1/backup', requireSession, async (request, response) => {
    const row = await current(request.session.user_id);
    await db.prepare('DELETE FROM backups WHERE user_id = ?').run(request.session.user_id);
    if (row?.diskName) await rm(join(directory, row.diskName), { force: true });
    response.status(204).end();
  });

  /** Files no account points to (a deleted account, an interrupted upload) are removed. */
  async function removeOrphanedBackups() {
    if (!(await stat(directory).catch(() => null))) return 0;
    const kept = new Set((await db.prepare('SELECT disk_name AS "diskName" FROM backups').all()).map((row) => row.diskName));
    let removed = 0;
    for (const name of await readdir(directory).catch(() => [])) {
      if (kept.has(name)) continue;
      const info = await stat(join(directory, name)).catch(() => null);
      // A file still being written is left alone for an hour.
      if (name.startsWith('.') && info && now() - info.mtimeMs < 60 * 60 * 1000) continue;
      await rm(join(directory, name), { force: true });
      removed += 1;
    }
    return removed;
  }

  return { removeOrphanedBackups };
}
