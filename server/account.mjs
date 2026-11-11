// Your account: request your account information (a JSON report, at once) and delete your account.
//
// Deleting needs the password. It removes everything the server keeps about you (sessions, devices and keys,
// contacts, statuses, business profile and catalog, labels, lists, channels you own, stored copies of your
// direct messages, profile photo…) and leaves a "Deleted account" placeholder so groups and chats other people
// still have keep making sense. Messages already on other people's phones stay with them, as on any messenger.
// The username is freed (it can be registered again).
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** What deletion removes: [table, where clause] with "?" = the user id (repeated as needed). */
export const PERSONAL_ROWS = [
  ['sessions', 'user_id = ?'],
  ['contacts', 'owner_id = ? OR contact_id = ?'],
  ['pairing_codes', 'user_id = ?'],
  ['message_reactions', 'user_id = ?'],
  ['message_hidden', 'user_id = ?'],
  ['poll_votes', 'user_id = ?'],
  ['poll_sealed_votes', 'user_id = ?'],
  ['status_views', 'viewer_id = ?'],
  ['status_views', 'status_id IN (SELECT id FROM statuses WHERE user_id = ?)'],
  ['statuses', 'user_id = ?'],
  ['status_audience_members', 'owner_id = ? OR user_id = ?'],
  ['identity_keys', 'user_id = ?'],
  ['e2e_prekeys', 'user_id = ?'],
  ['e2e_devices', 'user_id = ?'],
  ['push_devices', 'user_id = ?'],
  ['group_join_requests', 'user_id = ?'],
  ['group_members', 'user_id = ?'],
  ['message_stars', 'user_id = ?'],
  ['chat_prefs', 'user_id = ?'],
  ['business_auto_replies', 'user_id = ? OR peer_id = ?'],
  ['business_profiles', 'user_id = ?'],
  ['catalog_collections', 'user_id = ?'],
  ['verified_accounts', 'user_id = ?'],
  ['verification_requests', 'user_id = ?'],
  ['verification_tickets', 'requester_id = ?'],
  ['catalog_items', 'user_id = ?'],
  ['label_chats', 'label_id IN (SELECT id FROM labels WHERE user_id = ?)'],
  ['labels', 'user_id = ?'],
  ['quick_replies', 'user_id = ?'],
  ['broadcast_members', 'list_id IN (SELECT id FROM broadcast_lists WHERE owner_id = ?) OR user_id = ?'],
  ['broadcast_lists', 'owner_id = ?'],
  ['channel_reactions', 'user_id = ? OR post_id IN (SELECT p.id FROM channel_posts p JOIN channels c ON c.id = p.channel_id WHERE c.owner_id = ?)'],
  ['channel_posts', 'channel_id IN (SELECT id FROM channels WHERE owner_id = ?)'],
  ['channel_followers', 'user_id = ? OR channel_id IN (SELECT id FROM channels WHERE owner_id = ?)'],
  ['channel_admins', 'user_id = ? OR channel_id IN (SELECT id FROM channels WHERE owner_id = ?)'],
  ['channels', 'owner_id = ?'],
  ['scheduled_messages', 'owner_id = ? OR receiver_id = ?'],
  ['call_links', 'owner_id = ?'],
  ['chat_settings', 'user_a = ? OR user_b = ?'],
  ['messages', 'sender_id = ? OR receiver_id = ?'],
];

export function registerAccount({ app, db, requireSession, verifyPassword, closeUserSessions, avatarDirectory, catalogDirectory }) {
  const placeholders = (clause) => (clause.match(/\?/g) ?? []).length;

  // Your account information, as a download (no message contents: those are end-to-end encrypted on your phones).
  app.get('/api/v1/me/account-info', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const user = await db.prepare(`SELECT id, username, name, dob, created_at AS "createdAt", last_seen_privacy AS "lastSeen", online_privacy AS "online",
      photo_privacy AS "profilePhoto", read_receipts AS "readReceipts", status_audience AS "statusAudience", two_step_set_at AS "twoStepSince", country FROM users WHERE id = ?`).get(userId);
    const safe = async (sql) => { try { return await db.prepare(sql).all(userId); } catch { return []; } };
    const report = {
      generatedAt: new Date().toISOString(),
      about: 'Account information from Hidden Messenger. Message contents are not included: they are end-to-end encrypted and only your devices can read them.',
      account: user ? { ...user, createdAt: new Date(Number(user.createdAt)).toISOString(), readReceipts: Boolean(Number(user.readReceipts)), twoStepVerification: Boolean(user.twoStepSince) } : null,
      devices: await safe('SELECT device_name AS "name", created_at AS "linkedAt", last_active_at AS "lastActiveAt" FROM sessions WHERE user_id = ?'),
      contacts: await safe('SELECT u.username FROM contacts c JOIN users u ON u.id = c.contact_id WHERE c.owner_id = ?'),
      groups: await safe('SELECT g.name, m.role FROM group_members m JOIN groups g ON g.id = m.group_id WHERE m.user_id = ?'),
      channels: await safe('SELECT name, category, created_at AS "createdAt" FROM channels WHERE owner_id = ?'),
      following: await safe('SELECT c.name FROM channel_followers f JOIN channels c ON c.id = f.channel_id WHERE f.user_id = ?'),
      businessProfile: (await safe('SELECT category, description, address, email, website, links FROM business_profiles WHERE user_id = ?'))[0] ?? null,
      catalog: await safe('SELECT name, description, price, currency FROM catalog_items WHERE user_id = ?'),
      labels: await safe('SELECT name, color FROM labels WHERE user_id = ?'),
      quickReplies: await safe('SELECT shortcut, text FROM quick_replies WHERE user_id = ?'),
    };
    response.set('Content-Disposition', `attachment; filename="hidden-messenger-account-info-${user?.username ?? 'account'}.json"`);
    response.set('Cache-Control', 'no-store');
    response.json(report);
  });

  // Delete my account (needs the password). Irreversible.
  app.delete('/api/v1/me', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const row = await db.prepare('SELECT username, password_hash AS "hash", avatar_disk_name AS "avatar" FROM users WHERE id = ?').get(userId);
    if (!row) return response.status(404).json({ error: 'Account not found.' });
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!row.hash || !(await verifyPassword(password, row.hash))) return response.status(401).json({ error: 'That password is not correct.' });
    if (request.body?.confirm !== row.username) return response.status(400).json({ error: `Type your username (${row.username}) to confirm.` });

    // Files to remove after the rows (the SQLite driver answers synchronously, Postgres with promises).
    const catalogFiles = await db.prepare('SELECT image_disk_name AS "file" FROM catalog_items WHERE user_id = ? AND image_disk_name IS NOT NULL').all(userId);
    const cover = await db.prepare('SELECT cover_disk_name AS "file" FROM business_profiles WHERE user_id = ?').get(userId);
    // Sign out everywhere first (sockets close, push stops), then remove the rows.
    await closeUserSessions(userId, 'This account was deleted');
    for (const [table, where] of PERSONAL_ROWS) {
      await db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...Array(placeholders(where)).fill(userId));
    }
    // A placeholder keeps other people's groups and chats consistent; the username is freed.
    const tombstone = `deleted_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    await db.prepare(`UPDATE users SET username = ?, name = 'Deleted account', initials = '?', dob = NULL, password_hash = NULL, two_step_hash = NULL,
      avatar_disk_name = NULL, avatar_type = NULL, is_admin = 0, country = NULL, country_updated_at = NULL, deleted_at = ? WHERE id = ?`).run(tombstone, Date.now(), userId);
    if (row.avatar) await unlink(join(avatarDirectory, row.avatar)).catch(() => {});
    for (const file of [...catalogFiles.map((item) => item.file), cover?.file].filter(Boolean)) await unlink(join(catalogDirectory, file)).catch(() => {});
    response.status(204).end();
  });
}
