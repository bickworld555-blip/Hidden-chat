import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export async function checkGroupContract({ api, register, service }) {
  const admin = await register('group_admin');
  const member = await register('group_member');
  const stranger = await register('group_stranger');
  const create = await api('/api/v1/groups', { session: admin, method: 'POST', body: { name: 'Team', memberIds: [member.user.id] } });
  assert.equal(create.status, 201);
  const id = create.data.id;
  const path = `/api/v1/groups/${id}`;
  assert.equal((await api(path, { session: stranger })).status, 404);
  assert.equal((await api('/api/v1/groups', { session: stranger })).data.length, 0);
  const details = await api(path, { session: member });
  assert.equal(details.data.role, 'member');
  assert.equal(details.data.members.length, 2);
  assert.equal((await api(`${path}/members`, { session: member, method: 'POST', body: { userId: stranger.user.id } })).status, 403);
  assert.equal((await api(`${path}/members`, { session: admin, method: 'POST', body: { userId: stranger.user.id } })).status, 201);
  assert.equal((await api(`${path}/member-settings`, { session: member, method: 'PUT', body: { autoDelete: true } })).status, 200);
  const sent = await api(`${path}/messages`, { session: member, method: 'POST', body: { content: 'temporary text' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.expiresAt - sent.data.createdAt, 86_400_000);
  const listing = await api('/api/v1/groups', { session: admin });
  assert.equal(listing.data[0].lastContent, 'temporary text');
  assert.equal(listing.data[0].lastSenderId, member.user.id);
  assert.equal(listing.data[0].lastSenderName, member.user.name, 'group previews name the sender');
  assert.equal(listing.data[0].lastMessageAt, sent.data.createdAt);
  assert.equal(listing.data[0].unread, 1, 'the admin has not read the member\'s message');
  assert.equal((await api('/api/v1/groups', { session: member })).data[0].unread, 0, 'a sender never counts their own message');
  assert.equal((await api(`${path}/read`, { session: admin, method: 'PUT' })).status, 200);
  assert.equal((await api('/api/v1/groups', { session: admin })).data[0].unread, 0);
  assert.equal((await api(`${path}/messages`, { session: member, method: 'POST', body: { content: 'voice:unsupported' } })).status, 400);
  assert.equal((await api(`${path}/messages/${sent.data.id}`, { session: stranger, method: 'DELETE' })).status, 403);
  assert.equal(await service.expireGroupMessages(sent.data.expiresAt - 1), 0);
  assert.equal(await service.expireGroupMessages(sent.data.expiresAt), 1);
  assert.equal((await api(`${path}/messages`, { session: admin })).data.length, 0);
  assert.equal((await api('/api/v1/groups', { session: admin })).data[0].lastContent, null);
  assert.equal((await service.db.prepare('SELECT content FROM group_messages WHERE id = ?').get(sent.data.id)), undefined);
  await api(`${path}/member-settings`, { session: member, method: 'PUT', body: { autoDelete: false } });
  const normal = (await api(`${path}/messages`, { session: member, method: 'POST', body: { content: 'permanent text' } })).data;
  assert.equal(normal.expiresAt, null);
  assert.equal((await api(`${path}/messages/${normal.id}`, { session: member, method: 'DELETE' })).status, 204);
  const old = (await api(`${path}/messages`, { session: member, method: 'POST', body: { content: 'old message' } })).data;
  await service.db.prepare('UPDATE group_messages SET created_at = ? WHERE id = ?').run(Date.now() - 86_400_001, old.id);
  assert.equal((await api(`${path}/messages/${old.id}`, { session: member, method: 'DELETE' })).status, 403);
  assert.equal((await api(`${path}/messages/${old.id}`, { session: admin, method: 'DELETE' })).status, 204);
  assert.equal((await api(`${path}/messages`, { session: member })).data.length, 0);

  // Clearing: a member hides the history from their own view only; an admin may purge it for everyone.
  const kept = (await api(`${path}/messages`, { session: admin, method: 'POST', body: { content: 'before clear' } })).data;
  assert.equal((await api(`${path}/clear`, { session: member, method: 'POST', body: {} })).status, 200);
  assert.equal((await api(`${path}/messages`, { session: member })).data.length, 0);
  assert.equal((await api('/api/v1/groups', { session: member })).data[0].lastContent, null);
  assert.equal((await api(`${path}/messages`, { session: admin })).data.length, 1, 'the admin still sees it');
  assert.equal((await api(`${path}/clear`, { session: member, method: 'POST', body: { everyone: true } })).status, 403);
  assert.equal((await api(`${path}/clear`, { session: admin, method: 'POST', body: { everyone: true } })).data.cleared, 1);
  assert.equal(await service.db.prepare('SELECT 1 FROM group_messages WHERE id = ?').get(kept.id), undefined);

  // Reports are recorded; they do not need admin rights and reject empty reasons.
  assert.equal((await api(`${path}/report`, { session: member, method: 'POST', body: { reason: '' } })).status, 400);
  assert.equal((await api(`${path}/report`, { session: member, method: 'POST', body: { reason: 'Spam links' } })).status, 201);
  assert.equal((await api(`${path}/report`, { session: stranger, method: 'POST', body: { reason: 'x' } })).status, 201, 'the stranger was added as a member above');
  assert.equal(Number((await service.db.prepare('SELECT count(*) AS total FROM group_reports WHERE group_id = ?').get(id)).total), 2);

  assert.equal((await api(`${path}/membership`, { session: admin, method: 'DELETE' })).status, 409);
  assert.equal((await api(`${path}/membership`, { session: member, method: 'DELETE' })).status, 204);
  assert.equal((await api(`${path}/membership`, { session: member, method: 'DELETE' })).status, 404);
  assert.equal((await api(path, { session: member })).status, 404);
  assert.equal((await api(`${path}/messages`, { session: member })).status, 404);
  assert.equal((await api('/api/v1/groups', { session: member })).data.length, 0);
  assert.equal((await api(path, { session: admin })).data.members.length, 2);
}

// Attachments: upload scoped to a group, readable only by members, and the file disappears with the last message
// that references it (and only then).
export async function checkGroupAttachments({ api, register, service, url, mediaDirectory }) {
  const admin = await register('attach_admin');
  const member = await register('attach_member');
  const outsider = await register('attach_outsider');
  const group = (await api('/api/v1/groups', { session: admin, method: 'POST', body: { name: 'Files', memberIds: [member.user.id] } })).data;
  const path = `/api/v1/groups/${group.id}`;
  const bytes = Buffer.from('group file bytes');
  const upload = async (session, query) => fetch(`${url}/api/v1/media?${query}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + session.token, 'Content-Type': 'image/png', 'X-File-Name': 'photo.png' },
    body: bytes,
  });
  assert.equal((await upload(outsider, `groupId=${group.id}`)).status, 400, 'non-members cannot upload into the group');
  assert.equal((await upload(admin, `groupId=${group.id}&receiverId=${member.user.id}`)).status, 400, 'one target only');
  const uploaded = await upload(admin, `groupId=${group.id}`);
  assert.equal(uploaded.status, 201);
  const media = await uploaded.json();
  const diskName = (await service.db.prepare('SELECT disk_name AS "diskName" FROM media WHERE id = ?').get(media.id)).diskName;
  assert.ok(existsSync(join(mediaDirectory, diskName)));

  // Only the uploader, and only in this group, may attach it to a message.
  assert.equal((await api(`${path}/messages`, { session: member, method: 'POST', body: { content: `media:${media.id}:photo.png` } })).status, 400);
  const other = (await api('/api/v1/groups', { session: admin, method: 'POST', body: { name: 'Other', memberIds: [] } })).data;
  assert.equal((await api(`/api/v1/groups/${other.id}/messages`, { session: admin, method: 'POST', body: { content: `media:${media.id}:photo.png` } })).status, 400);
  const first = (await api(`${path}/messages`, { session: admin, method: 'POST', body: { content: `media:${media.id}:photo.png` } })).data;
  const second = (await api(`${path}/messages`, { session: admin, method: 'POST', body: { content: `media:${media.id}:photo.png` } })).data;
  assert.equal(first.content, second.content);

  const download = (session) => fetch(`${url}/api/v1/media/${media.id}`, { headers: { Authorization: 'Bearer ' + session.token } });
  assert.equal((await download(member)).status, 200, 'members download group attachments');
  assert.equal((await download(outsider)).status, 404, 'outsiders cannot');

  // Deleting one of two referencing messages keeps the shared file; deleting the last one removes it.
  assert.equal((await api(`${path}/messages/${first.id}`, { session: admin, method: 'DELETE' })).status, 204);
  assert.ok(existsSync(join(mediaDirectory, diskName)), 'still referenced by the second message');
  assert.equal((await download(member)).status, 200);
  assert.equal((await api(`${path}/messages/${second.id}`, { session: admin, method: 'DELETE' })).status, 204);
  assert.equal(existsSync(join(mediaDirectory, diskName)), false, 'last reference gone: file purged');
  assert.equal(await service.db.prepare('SELECT 1 FROM media WHERE id = ?').get(media.id), undefined);
  assert.equal((await download(member)).status, 404);

  // Expiry purges attachments the same way.
  await api(`${path}/member-settings`, { session: member, method: 'PUT', body: { autoDelete: true } });
  const timed = await (await upload(member, `groupId=${group.id}`)).json();
  const timedMessage = (await api(`${path}/messages`, { session: member, method: 'POST', body: { content: `media:${timed.id}:photo.png` } })).data;
  const timedDisk = (await service.db.prepare('SELECT disk_name AS "diskName" FROM media WHERE id = ?').get(timed.id)).diskName;
  assert.equal(await service.expireGroupMessages(timedMessage.expiresAt), 1);
  assert.equal(existsSync(join(mediaDirectory, timedDisk)), false);

  // Uploaded but never attached: the hourly sweep removes it once it is older than an in-progress upload could be.
  const stranded = await (await upload(admin, `groupId=${group.id}`)).json();
  const strandedDisk = (await service.db.prepare('SELECT disk_name AS "diskName" FROM media WHERE id = ?').get(stranded.id)).diskName;
  assert.equal(await service.removeOrphanedMedia(), 0, 'a fresh upload is left alone');
  assert.ok(existsSync(join(mediaDirectory, strandedDisk)));
  assert.equal(await service.removeOrphanedMedia(Date.now() + 365 * 86_400_000), 1);
  assert.equal(existsSync(join(mediaDirectory, strandedDisk)), false);

  // A referenced attachment is never swept, and a member who left can no longer download it.
  const lasting = await (await upload(admin, `groupId=${group.id}`)).json();
  await api(`${path}/messages`, { session: admin, method: 'POST', body: { content: `media:${lasting.id}:photo.png` } });
  assert.equal((await fetch(`${url}/api/v1/media/${lasting.id}`, { headers: { Authorization: 'Bearer ' + member.token } })).status, 200);
  await api(`${path}/membership`, { session: member, method: 'DELETE' });
  assert.equal((await fetch(`${url}/api/v1/media/${lasting.id}`, { headers: { Authorization: 'Bearer ' + member.token } })).status, 404);
  assert.equal(await service.removeOrphanedMedia(Date.now() + 365 * 86_400_000), 0);
}
