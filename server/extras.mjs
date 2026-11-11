// WhatsApp features beyond chats (server side): broadcast lists, channels, scheduled messages, status privacy and
// call links. index.mjs owns sessions, sockets and message delivery; this module gets them through `ctx`.
//
//   Broadcast lists  the owner's saved recipient lists; each send is an ordinary (end-to-end encrypted) direct
//                    message per recipient, and only people who saved the sender as a contact get it (WhatsApp).
//   Channels         one-way public broadcasts with followers (like WhatsApp Channels, not end-to-end encrypted:
//                    anyone may follow). Followers are not shown to each other; reactions are counted, not named.
//   Scheduled        a direct message sealed on the sender's device and held here until its time.
//   Status privacy   who sees my status: my contacts, my contacts except…, or only share with….
//   Call links       a link that lets someone call you (and only you) without being a contact; you can revoke it.
import { randomBytes, randomUUID } from 'node:crypto';
import { isEnvelope, MAX_DIRECT_ENVELOPE } from '../src/e2e/envelope.js';

export const MAX_BROADCAST_LISTS = 50;
export const MAX_BROADCAST_MEMBERS = 256;
export const MAX_CHANNEL_POST = 4000;
export const MAX_SCHEDULED_PER_USER = 100;
export const MAX_SCHEDULE_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
export const STATUS_AUDIENCES = ['contacts', 'except', 'only'];
export const CHANNEL_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
/** Directory categories (the owner picks one; "other" when unset). */
export const CHANNEL_CATEGORIES = ['business', 'news', 'entertainment', 'sports', 'lifestyle', 'education', 'technology', 'community', 'other'];
export const MAX_CHANNEL_ADMINS = 16;

export function ensureExtrasSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS broadcast_lists (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS broadcast_members (list_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (list_id, user_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS channel_followers (channel_id TEXT NOT NULL, user_id TEXT NOT NULL, followed_at INTEGER NOT NULL, PRIMARY KEY (channel_id, user_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS channel_posts (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS channel_reactions (post_id TEXT NOT NULL, user_id TEXT NOT NULL, emoji TEXT NOT NULL, PRIMARY KEY (post_id, user_id))`);
  // Directory categories and admins (Postgres: 015_channel_directory.sql).
  db.exec(`CREATE TABLE IF NOT EXISTS channel_admins (channel_id TEXT NOT NULL, user_id TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (channel_id, user_id))`);
  if (!new Set(db.prepare('PRAGMA table_info(channels)').all().map((column) => column.name)).has('category')) db.exec("ALTER TABLE channels ADD COLUMN category TEXT NOT NULL DEFAULT 'other'");
  db.exec(`CREATE TABLE IF NOT EXISTS scheduled_messages (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, receiver_id TEXT NOT NULL, content TEXT NOT NULL, send_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS status_audience_members (owner_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (owner_id, user_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS call_links (code TEXT PRIMARY KEY, owner_id TEXT NOT NULL, mode TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER)`);
  const users = new Set(db.prepare('PRAGMA table_info(users)').all().map((column) => column.name));
  if (!users.has('status_audience')) db.exec("ALTER TABLE users ADD COLUMN status_audience TEXT NOT NULL DEFAULT 'contacts'");
}

/**
 * SQL that is true when the status owner's privacy lets `viewer` see their statuses (owner and viewer are SQL
 * expressions; the viewer is also a contact of the owner, checked separately).
 */
export function statusAudienceSql(owner, viewer) {
  const audience = `COALESCE((SELECT status_audience FROM users WHERE id = ${owner}), 'contacts')`;
  return `(${audience} = 'contacts'
    OR (${audience} = 'except' AND NOT EXISTS (SELECT 1 FROM status_audience_members m WHERE m.owner_id = ${owner} AND m.user_id = ${viewer}))
    OR (${audience} = 'only' AND EXISTS (SELECT 1 FROM status_audience_members m WHERE m.owner_id = ${owner} AND m.user_id = ${viewer})))`;
}

const cleanText = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');

export function registerExtras({ verifiedChannels = { has: () => false }, app, db, requireSession, broadcastUser, publicUser, userColumns, deliverDirectMessage, linkUsers, appOrigin = () => '' }) {
  const userRow = db.prepare(`SELECT ${userColumns} FROM users WHERE id = ?`);
  const fail = (response, status, error) => response.status(status).json({ error });

  // --- Broadcast lists ------------------------------------------------------------------------------------
  async function listOf(ownerId, listId) {
    const list = await db.prepare('SELECT id, name, created_at AS "createdAt" FROM broadcast_lists WHERE id = ? AND owner_id = ?').get(listId, ownerId);
    if (!list) return null;
    const members = await db.prepare(`SELECT u.id, u.username, u.name, u.initials, u.color,
        EXISTS (SELECT 1 FROM contacts c WHERE c.owner_id = u.id AND c.contact_id = ? AND c.saved = 1) AS "savedMe"
      FROM broadcast_members m JOIN users u ON u.id = m.user_id WHERE m.list_id = ? ORDER BY u.name`).all(ownerId, listId);
    // Only people who saved the sender as a contact receive broadcasts (WhatsApp's rule against spam).
    return { ...list, createdAt: Number(list.createdAt), members: members.map((member) => ({ ...member, canReceive: Boolean(Number(member.savedMe)) || member.savedMe === true })) };
  }

  async function setMembers(listId, ownerId, ids) {
    const unique = [...new Set(ids)].filter((id) => typeof id === 'string' && id && id !== ownerId).slice(0, MAX_BROADCAST_MEMBERS);
    await db.prepare('DELETE FROM broadcast_members WHERE list_id = ?').run(listId);
    for (const id of unique) {
      if (await db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) await db.prepare('INSERT INTO broadcast_members(list_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(listId, id);
    }
  }

  app.get('/api/v1/broadcasts', requireSession, async (request, response) => {
    const rows = await db.prepare('SELECT id FROM broadcast_lists WHERE owner_id = ? ORDER BY created_at DESC').all(request.session.user_id);
    const lists = [];
    for (const row of rows) lists.push(await listOf(request.session.user_id, row.id));
    response.json(lists);
  });

  app.post('/api/v1/broadcasts', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const name = cleanText(request.body?.name, 60);
    const members = request.body?.memberIds;
    if (!name || !Array.isArray(members) || members.length < 1) return fail(response, 400, 'Give the list a name and at least one recipient.');
    if (Number((await db.prepare('SELECT count(*) AS "count" FROM broadcast_lists WHERE owner_id = ?').get(userId)).count) >= MAX_BROADCAST_LISTS) {
      return fail(response, 409, `You can have up to ${MAX_BROADCAST_LISTS} broadcast lists.`);
    }
    const id = randomUUID();
    await db.prepare('INSERT INTO broadcast_lists(id, owner_id, name, created_at) VALUES (?, ?, ?, ?)').run(id, userId, name, Date.now());
    await setMembers(id, userId, members);
    response.status(201).json(await listOf(userId, id));
  });

  app.put('/api/v1/broadcasts/:id', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    if (!await listOf(userId, request.params.id)) return fail(response, 404, 'Broadcast list not found.');
    const name = cleanText(request.body?.name, 60);
    if (name) await db.prepare('UPDATE broadcast_lists SET name = ? WHERE id = ?').run(name, request.params.id);
    if (Array.isArray(request.body?.memberIds)) await setMembers(request.params.id, userId, request.body.memberIds);
    response.json(await listOf(userId, request.params.id));
  });

  app.delete('/api/v1/broadcasts/:id', requireSession, async (request, response) => {
    const removed = await db.prepare('DELETE FROM broadcast_lists WHERE id = ? AND owner_id = ? RETURNING id').get(request.params.id, request.session.user_id);
    if (!removed) return fail(response, 404, 'Broadcast list not found.');
    await db.prepare('DELETE FROM broadcast_members WHERE list_id = ?').run(request.params.id);
    response.status(204).end();
  });

  // --- Channels ---------------------------------------------------------------------------------------------
  async function channelView(channelId, viewerId) {
    const channel = await db.prepare(`SELECT c.id, c.owner_id AS "ownerId", c.name, c.description, c.category, c.created_at AS "createdAt",
        (SELECT count(*) FROM channel_followers f WHERE f.channel_id = c.id) AS "followers",
        EXISTS (SELECT 1 FROM channel_followers f WHERE f.channel_id = c.id AND f.user_id = ?) AS "following",
        EXISTS (SELECT 1 FROM channel_admins a WHERE a.channel_id = c.id AND a.user_id = ?) AS "admin"
      FROM channels c WHERE c.id = ?`).get(viewerId, viewerId, channelId);
    if (!channel) return null;
    const mine = channel.ownerId === viewerId;
    const admin = !mine && (Boolean(Number(channel.admin)) || channel.admin === true);
    // mine = owner (edits, deletes, manages admins); admins post and delete updates too.
    const { admin: _admin, ...rest } = channel;
    return { ...rest, category: CHANNEL_CATEGORIES.includes(channel.category) ? channel.category : 'other', createdAt: Number(channel.createdAt), followers: Number(channel.followers),
      following: Boolean(Number(channel.following)) || channel.following === true, mine, role: mine ? 'owner' : admin ? 'admin' : null, canPost: mine || admin,
      ...(verifiedChannels.has(channel.id) ? { verified: true } : {}) };
  }

  async function postsOf(channelId, viewerId) {
    const posts = await db.prepare('SELECT id, content, created_at AS "createdAt" FROM channel_posts WHERE channel_id = ? ORDER BY created_at DESC LIMIT 100').all(channelId);
    const out = [];
    for (const post of posts.reverse()) {
      const reactions = await db.prepare('SELECT emoji, count(*) AS "count" FROM channel_reactions WHERE post_id = ? GROUP BY emoji').all(post.id);
      const mine = await db.prepare('SELECT emoji FROM channel_reactions WHERE post_id = ? AND user_id = ?').get(post.id, viewerId);
      out.push({ ...post, createdAt: Number(post.createdAt), reactions: Object.fromEntries(reactions.map((row) => [row.emoji, Number(row.count)])), myReaction: mine?.emoji ?? null });
    }
    return out;
  }

  async function notifyFollowers(channelId, event) {
    const followers = await db.prepare('SELECT user_id AS "userId" FROM channel_followers WHERE channel_id = ?').all(channelId);
    const owner = await db.prepare('SELECT owner_id AS "ownerId" FROM channels WHERE id = ?').get(channelId);
    const admins = await db.prepare('SELECT user_id AS "userId" FROM channel_admins WHERE channel_id = ?').all(channelId);
    for (const id of new Set([...followers.map((row) => row.userId), ...admins.map((row) => row.userId), owner?.ownerId].filter(Boolean))) broadcastUser(id, event);
  }

  app.get('/api/v1/channels', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const rows = await db.prepare(`SELECT c.id FROM channels c WHERE c.owner_id = ?
      OR EXISTS (SELECT 1 FROM channel_admins a WHERE a.channel_id = c.id AND a.user_id = ?)
      OR EXISTS (SELECT 1 FROM channel_followers f WHERE f.channel_id = c.id AND f.user_id = ?) ORDER BY c.created_at DESC`).all(userId, userId, userId);
    const out = [];
    for (const row of rows) out.push(await channelView(row.id, userId));
    response.json(out);
  });

  app.get('/api/v1/channels/discover', requireSession, async (request, response) => {
    const query = cleanText(String(request.query.q ?? ''), 60).toLowerCase();
    const category = CHANNEL_CATEGORIES.includes(request.query.category) ? request.query.category : '';
    const rows = await db.prepare(`SELECT c.id FROM channels c WHERE (lower(c.name) LIKE ? OR lower(c.description) LIKE ?)${category ? ' AND c.category = ?' : ''} ORDER BY
      (SELECT count(*) FROM channel_followers f WHERE f.channel_id = c.id) DESC, c.created_at DESC LIMIT 50`)
      .all(...[`%${query.replace(/[%_]/g, '')}%`, `%${query.replace(/[%_]/g, '')}%`, ...(category ? [category] : [])]);
    const out = [];
    for (const row of rows) out.push(await channelView(row.id, request.session.user_id));
    response.json(out);
  });

  app.post('/api/v1/channels', requireSession, async (request, response) => {
    const name = cleanText(request.body?.name, 80);
    if (!name) return fail(response, 400, 'Give the channel a name.');
    const id = randomUUID();
    const category = CHANNEL_CATEGORIES.includes(request.body?.category) ? request.body.category : 'other';
    await db.prepare('INSERT INTO channels(id, owner_id, name, description, category, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, request.session.user_id, name, cleanText(request.body?.description, 500), category, Date.now());
    response.status(201).json(await channelView(id, request.session.user_id));
  });

  app.get('/api/v1/channels/:id', requireSession, async (request, response) => {
    const channel = await channelView(request.params.id, request.session.user_id);
    if (!channel) return fail(response, 404, 'Channel not found.');
    response.json({ ...channel, posts: await postsOf(channel.id, request.session.user_id) });
  });

  app.put('/api/v1/channels/:id', requireSession, async (request, response) => {
    const channel = await channelView(request.params.id, request.session.user_id);
    if (!channel?.mine) return fail(response, channel ? 403 : 404, channel ? 'Only the channel owner can edit it.' : 'Channel not found.');
    const name = cleanText(request.body?.name, 80) || channel.name;
    const description = request.body?.description === undefined ? channel.description : cleanText(request.body.description, 500);
    const category = request.body?.category === undefined ? channel.category : CHANNEL_CATEGORIES.includes(request.body.category) ? request.body.category : null;
    if (!category) return fail(response, 400, 'Choose one of the channel categories.');
    await db.prepare('UPDATE channels SET name = ?, description = ?, category = ? WHERE id = ?').run(name, description, category, channel.id);
    response.json(await channelView(channel.id, request.session.user_id));
  });

  app.delete('/api/v1/channels/:id', requireSession, async (request, response) => {
    const channel = await channelView(request.params.id, request.session.user_id);
    if (!channel?.mine) return fail(response, channel ? 403 : 404, channel ? 'Only the channel owner can delete it.' : 'Channel not found.');
    await db.prepare('DELETE FROM channel_reactions WHERE post_id IN (SELECT id FROM channel_posts WHERE channel_id = ?)').run(channel.id);
    await db.prepare('DELETE FROM channel_posts WHERE channel_id = ?').run(channel.id);
    await db.prepare('DELETE FROM channel_followers WHERE channel_id = ?').run(channel.id);
    await db.prepare('DELETE FROM channel_admins WHERE channel_id = ?').run(channel.id);
    await db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
    response.status(204).end();
  });

  app.get('/api/v1/channels/:id/admins', requireSession, async (request, response) => {
    const channel = await channelView(request.params.id, request.session.user_id);
    if (!channel?.canPost) return fail(response, channel ? 403 : 404, channel ? 'Only the channel owner and admins can see this.' : 'Channel not found.');
    const rows = await db.prepare(`SELECT u.id, u.username, u.name, u.initials, u.color FROM channel_admins a JOIN users u ON u.id = a.user_id
      WHERE a.channel_id = ? ORDER BY a.added_at`).all(channel.id);
    const owner = await db.prepare('SELECT id, username, name, initials, color FROM users WHERE id = ?').get(channel.ownerId);
    response.json({ owner, admins: rows });
  });

  app.post('/api/v1/channels/:id/admins', requireSession, async (request, response) => {
    const channel = await channelView(request.params.id, request.session.user_id);
    if (!channel?.mine) return fail(response, channel ? 403 : 404, channel ? 'Only the channel owner can add admins.' : 'Channel not found.');
    const username = cleanText(String(request.body?.username ?? ''), 40).replace(/^@/, '').toLowerCase();
    const user = username && await db.prepare('SELECT id FROM users WHERE lower(username) = ?').get(username);
    if (!user) return fail(response, 404, `No one is called @${username || '…'}.`);
    if (user.id === channel.ownerId) return fail(response, 400, 'The owner already manages this channel.');
    const count = Number((await db.prepare('SELECT count(*) AS "count" FROM channel_admins WHERE channel_id = ?').get(channel.id))?.count ?? 0);
    if (count >= MAX_CHANNEL_ADMINS) return fail(response, 400, `A channel can have up to ${MAX_CHANNEL_ADMINS} admins.`);
    await db.prepare('INSERT INTO channel_admins(channel_id, user_id, added_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(channel.id, user.id, Date.now());
    broadcastUser(user.id, { type: 'channel:admin', channelId: channel.id, channelName: channel.name });
    response.status(201).json({ ok: true });
  });

  app.delete('/api/v1/channels/:id/admins/:userId', requireSession, async (request, response) => {
    const channel = await channelView(request.params.id, request.session.user_id);
    const self = request.params.userId === request.session.user_id;
    if (!channel || (!channel.mine && !(self && channel.role === 'admin'))) return fail(response, channel ? 403 : 404, channel ? 'Only the channel owner can remove admins.' : 'Channel not found.');
    await db.prepare('DELETE FROM channel_admins WHERE channel_id = ? AND user_id = ?').run(channel.id, request.params.userId);
    response.status(204).end();
  });

  app.post('/api/v1/channels/:id/follow', requireSession, async (request, response) => {
    if (!await channelView(request.params.id, request.session.user_id)) return fail(response, 404, 'Channel not found.');
    await db.prepare('INSERT INTO channel_followers(channel_id, user_id, followed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(request.params.id, request.session.user_id, Date.now());
    response.json(await channelView(request.params.id, request.session.user_id));
  });

  app.delete('/api/v1/channels/:id/follow', requireSession, async (request, response) => {
    await db.prepare('DELETE FROM channel_followers WHERE channel_id = ? AND user_id = ?').run(request.params.id, request.session.user_id);
    response.status(204).end();
  });

  app.post('/api/v1/channels/:id/posts', requireSession, async (request, response) => {
    const channel = await channelView(request.params.id, request.session.user_id);
    if (!channel?.canPost) return fail(response, channel ? 403 : 404, channel ? 'Only the channel owner and admins can post.' : 'Channel not found.');
    const content = typeof request.body?.content === 'string' ? request.body.content.trim() : '';
    if (!content || content.length > MAX_CHANNEL_POST || isEnvelope(content)) return fail(response, 400, `Write up to ${MAX_CHANNEL_POST} characters.`);
    const post = { id: randomUUID(), content, createdAt: Date.now() };
    await db.prepare('INSERT INTO channel_posts(id, channel_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)').run(post.id, channel.id, request.session.user_id, post.content, post.createdAt);
    await notifyFollowers(channel.id, { type: 'channel:post', channelId: channel.id, channelName: channel.name, post: { ...post, reactions: {}, myReaction: null } });
    response.status(201).json(post);
  });

  app.delete('/api/v1/channels/:id/posts/:postId', requireSession, async (request, response) => {
    const channel = await channelView(request.params.id, request.session.user_id);
    if (!channel?.canPost) return fail(response, channel ? 403 : 404, channel ? 'Only the channel owner and admins can delete updates.' : 'Channel not found.');
    await db.prepare('DELETE FROM channel_reactions WHERE post_id = ?').run(request.params.postId);
    const removed = await db.prepare('DELETE FROM channel_posts WHERE id = ? AND channel_id = ? RETURNING id').get(request.params.postId, channel.id);
    if (!removed) return fail(response, 404, 'Post not found.');
    await notifyFollowers(channel.id, { type: 'channel:post-deleted', channelId: channel.id, postId: request.params.postId });
    response.status(204).end();
  });

  app.put('/api/v1/channels/:id/posts/:postId/reaction', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const post = await db.prepare('SELECT id FROM channel_posts WHERE id = ? AND channel_id = ?').get(request.params.postId, request.params.id);
    if (!post) return fail(response, 404, 'Post not found.');
    const emoji = request.body?.emoji ?? null;
    if (emoji !== null && !CHANNEL_REACTIONS.includes(emoji)) return fail(response, 400, 'Choose one of the reactions.');
    if (emoji === null) await db.prepare('DELETE FROM channel_reactions WHERE post_id = ? AND user_id = ?').run(post.id, userId);
    else await db.prepare(`INSERT INTO channel_reactions(post_id, user_id, emoji) VALUES (?, ?, ?)
      ON CONFLICT(post_id, user_id) DO UPDATE SET emoji = excluded.emoji`).run(post.id, userId, emoji);
    const counts = await db.prepare('SELECT emoji, count(*) AS "count" FROM channel_reactions WHERE post_id = ? GROUP BY emoji').all(post.id);
    response.json({ reactions: Object.fromEntries(counts.map((row) => [row.emoji, Number(row.count)])), myReaction: emoji });
  });

  // --- Scheduled messages -----------------------------------------------------------------------------------
  app.get('/api/v1/scheduled', requireSession, async (request, response) => {
    const rows = await db.prepare(`SELECT id, receiver_id AS "receiverId", content, send_at AS "sendAt", created_at AS "createdAt"
      FROM scheduled_messages WHERE owner_id = ? ORDER BY send_at`).all(request.session.user_id);
    response.json(rows.map((row) => ({ ...row, sendAt: Number(row.sendAt), createdAt: Number(row.createdAt) })));
  });

  app.post('/api/v1/scheduled', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const { receiverId, content } = request.body ?? {};
    const sendAt = Number(request.body?.sendAt);
    const now = Date.now();
    if (typeof receiverId !== 'string' || receiverId === userId || !await db.prepare('SELECT 1 FROM users WHERE id = ?').get(receiverId)) return fail(response, 400, 'Choose who gets the message.');
    if (typeof content !== 'string' || !content.trim() || content.length > (isEnvelope(content) ? MAX_DIRECT_ENVELOPE : 4000)) return fail(response, 400, 'Write the message (up to 4,000 characters).');
    if (!Number.isFinite(sendAt) || sendAt < now + 30_000 || sendAt > now + MAX_SCHEDULE_AHEAD_MS) return fail(response, 400, 'Pick a time at least a minute from now and within a year.');
    if (Number((await db.prepare('SELECT count(*) AS "count" FROM scheduled_messages WHERE owner_id = ?').get(userId)).count) >= MAX_SCHEDULED_PER_USER) {
      return fail(response, 409, `You can schedule up to ${MAX_SCHEDULED_PER_USER} messages.`);
    }
    const id = randomUUID();
    await db.prepare('INSERT INTO scheduled_messages(id, owner_id, receiver_id, content, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, userId, receiverId, content, sendAt, now);
    response.status(201).json({ id, receiverId, content, sendAt, createdAt: now });
  });

  app.delete('/api/v1/scheduled/:id', requireSession, async (request, response) => {
    const removed = await db.prepare('DELETE FROM scheduled_messages WHERE id = ? AND owner_id = ? RETURNING id').get(request.params.id, request.session.user_id);
    if (!removed) return fail(response, 404, 'Scheduled message not found.');
    response.status(204).end();
  });

  /** Sends what is due (called every few seconds). Returns how many went out. */
  async function deliverScheduled(now = Date.now()) {
    const due = await db.prepare('DELETE FROM scheduled_messages WHERE send_at <= ? RETURNING id, owner_id AS "ownerId", receiver_id AS "receiverId", content').all(now);
    let sent = 0;
    for (const item of due) {
      try {
        await deliverDirectMessage({ senderId: item.ownerId, receiverId: item.receiverId, content: item.content });
        sent += 1;
      } catch (error) {
        console.error('Scheduled message not delivered:', error.message);
      }
    }
    return sent;
  }

  // --- Status privacy ----------------------------------------------------------------------------------------
  app.get('/api/v1/me/status-privacy', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const row = await db.prepare('SELECT status_audience AS "audience" FROM users WHERE id = ?').get(userId);
    const members = await db.prepare('SELECT user_id AS "userId" FROM status_audience_members WHERE owner_id = ?').all(userId);
    response.json({ audience: row?.audience ?? 'contacts', userIds: members.map((member) => member.userId) });
  });

  app.put('/api/v1/me/status-privacy', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const audience = request.body?.audience;
    const ids = request.body?.userIds ?? [];
    if (!STATUS_AUDIENCES.includes(audience) || !Array.isArray(ids) || ids.length > 1000) return fail(response, 400, 'Choose who can see your status.');
    await db.prepare('UPDATE users SET status_audience = ? WHERE id = ?').run(audience, userId);
    await db.prepare('DELETE FROM status_audience_members WHERE owner_id = ?').run(userId);
    for (const id of new Set(ids.filter((value) => typeof value === 'string' && value && value !== userId))) {
      await db.prepare('INSERT INTO status_audience_members(owner_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING').run(userId, id);
    }
    response.json({ audience, userIds: [...new Set(ids)] });
  });

  // --- Call links ---------------------------------------------------------------------------------------------
  app.get('/api/v1/call-links', requireSession, async (request, response) => {
    const rows = await db.prepare('SELECT code, mode, created_at AS "createdAt" FROM call_links WHERE owner_id = ? AND revoked_at IS NULL ORDER BY created_at DESC').all(request.session.user_id);
    response.json(rows.map((row) => ({ ...row, createdAt: Number(row.createdAt), url: `${appOrigin()}/call/${row.code}` })));
  });

  app.post('/api/v1/call-links', requireSession, async (request, response) => {
    const mode = request.body?.mode === 'video' ? 'video' : 'audio';
    const code = randomBytes(12).toString('base64url');
    const createdAt = Date.now();
    await db.prepare('INSERT INTO call_links(code, owner_id, mode, created_at) VALUES (?, ?, ?, ?)').run(code, request.session.user_id, mode, createdAt);
    response.status(201).json({ code, mode, createdAt, url: `${appOrigin()}/call/${code}` });
  });

  app.delete('/api/v1/call-links/:code', requireSession, async (request, response) => {
    const revoked = await db.prepare('UPDATE call_links SET revoked_at = ? WHERE code = ? AND owner_id = ? AND revoked_at IS NULL RETURNING code')
      .get(Date.now(), request.params.code, request.session.user_id);
    if (!revoked) return fail(response, 404, 'Call link not found.');
    response.status(204).end();
  });

  app.get('/api/v1/call-links/:code', requireSession, async (request, response) => {
    const link = await db.prepare('SELECT owner_id AS "ownerId", mode FROM call_links WHERE code = ? AND revoked_at IS NULL').get(request.params.code);
    if (!link) return fail(response, 404, 'This call link was revoked or does not exist.');
    const owner = await userRow.get(link.ownerId);
    if (!owner) return fail(response, 404, 'This call link was revoked or does not exist.');
    response.json({ code: request.params.code, mode: link.mode, owner: publicUser(owner), mine: link.ownerId === request.session.user_id });
  });

  // Joining through a live link connects the two people (like a first message does), so the call can be placed.
  app.post('/api/v1/call-links/:code/join', requireSession, async (request, response) => {
    const userId = request.session.user_id;
    const link = await db.prepare('SELECT owner_id AS "ownerId", mode FROM call_links WHERE code = ? AND revoked_at IS NULL').get(request.params.code);
    if (!link) return fail(response, 404, 'This call link was revoked or does not exist.');
    if (link.ownerId === userId) return fail(response, 400, 'This is your own call link.');
    await linkUsers(userId, link.ownerId);
    await linkUsers(link.ownerId, userId);
    response.json({ ownerId: link.ownerId, mode: link.mode, owner: publicUser(await userRow.get(link.ownerId)) });
  });

  return { deliverScheduled };
}
