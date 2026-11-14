// Removes leftover QA test accounts from production through the app's own deletion (POST /api/v1/account/delete), so
// sessions, keys, push registrations, contacts and XMPP device accounts are cleaned exactly as for a real user.
//
// The accounts' passwords are not known, so for each matching, not-yet-deleted user this sets a fresh random password
// (scrypt, the server's own format) directly in the database and then deletes the account through the API.
//
//   node --env-file=.env scripts/delete-test-accounts.mjs            # dry run: lists what would be deleted
//   node --env-file=.env scripts/delete-test-accounts.mjs --delete   # deletes them
//
// Only usernames starting with one of PREFIXES and created in the last MAX_AGE_DAYS are touched.
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { createPostgresDatabase } from '../server/database.mjs';

const PREFIXES = ['qap2s', 'qap2o', 'qap2f'];
const MAX_AGE_DAYS = 7;
const API = process.env.HM_API_BASE || 'https://hiddenmessenger.com';
const scrypt = promisify(scryptCallback);

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString('base64url')}$${Buffer.from(key).toString('base64url')}`;
}

const remove = process.argv.includes('--delete');
const db = createPostgresDatabase();
try {
  const since = Date.now() - MAX_AGE_DAYS * 86_400_000;
  const like = PREFIXES.map(() => 'username LIKE ?').join(' OR ');
  const users = await db.prepare(`SELECT id, username FROM users WHERE deleted_at IS NULL AND created_at > ? AND (${like}) ORDER BY created_at`)
    .all(since, ...PREFIXES.map((prefix) => `${prefix}%`));
  console.log(`${users.length} test account(s):`, users.map((user) => user.username).join(', ') || '(none)');
  if (!remove) {
    console.log('Dry run. Add --delete to remove them.');
  } else {
    for (const user of users) {
      const password = `Cleanup-${randomBytes(12).toString('hex')}`;
      await db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND deleted_at IS NULL').run(await hashPassword(password), user.id);
      const response = await fetch(`${API}/api/v1/account/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-HM-Client': '2' },
        body: JSON.stringify({ username: user.username, password, confirm: 'DELETE' }),
      });
      console.log(`${user.username}: ${response.status === 204 ? 'deleted' : `NOT deleted (HTTP ${response.status})`}`);
      // The deletion endpoint is throttled per account; pause between accounts.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
} finally {
  await db.close();
}
