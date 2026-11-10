// Group calls through an SFU (Selective Forwarding Unit), prepared: each participant sends its media once to the
// SFU, which forwards it to the others, so a call is no longer limited by every phone uploading to every other
// phone (the 1:1 mesh caps calls at MESH_MAX_PARTICIPANTS). The SFU runs outside this server (it needs open UDP
// ports, which Node.js web hosting does not give): set SFU_URL, SFU_API_KEY and SFU_API_SECRET to enable it.
//
// This module is the signalling side: it says which topology calls use and gives a group's members short-lived
// access tokens to its room. Tokens are standard HS256 JWTs with a "video" grant, the format LiveKit and
// compatible SFUs accept (identity = user id, room = "group-<groupId>").
import { createHmac } from 'node:crypto';
import { MESH_MAX_PARTICIPANTS } from '../src/callTopology.js';

export const SFU_TOKEN_TTL_SECONDS = 10 * 60;
export const DEFAULT_SFU_MAX_PARTICIPANTS = 32;

/** { url, apiKey, apiSecret, maxParticipants } from the environment, or null when no SFU is configured. */
export function sfuConfigFromEnv(env = process.env) {
  const url = env.SFU_URL?.trim();
  const apiKey = env.SFU_API_KEY?.trim();
  const apiSecret = env.SFU_API_SECRET?.trim();
  if (!url && !apiKey && !apiSecret) return null;
  if (!url || !apiKey || !apiSecret) throw new Error('SFU_URL, SFU_API_KEY and SFU_API_SECRET are all required to enable SFU group calls.');
  const parsed = new URL(url);
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password) throw new Error('SFU_URL must be a wss:// URL without credentials.');
  if (apiSecret.length < 32) throw new Error('SFU_API_SECRET must be at least 32 characters.');
  const max = Number(env.SFU_MAX_PARTICIPANTS ?? DEFAULT_SFU_MAX_PARTICIPANTS);
  if (!Number.isInteger(max) || max < MESH_MAX_PARTICIPANTS || max > 1000) throw new Error(`SFU_MAX_PARTICIPANTS must be an integer from ${MESH_MAX_PARTICIPANTS} to 1000.`);
  return { url: parsed.href.replace(/\/$/, ''), apiKey, apiSecret, maxParticipants: max };
}

const base64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/** An SFU access token (JWT, HS256) for one user in one room. */
export function mintSfuToken(config, { identity, name, room, now = Date.now(), ttlSeconds = SFU_TOKEN_TTL_SECONDS }) {
  const issued = Math.floor(now / 1000);
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({
    iss: config.apiKey,
    sub: identity,
    name,
    nbf: issued - 5,
    iat: issued,
    exp: issued + ttlSeconds,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  });
  const signature = createHmac('sha256', config.apiSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export const roomForGroup = (groupId) => `group-${groupId}`;

export function registerSfu({ app, db, requireSession, config = sfuConfigFromEnv() }) {
  // What calls may use: mesh always; an SFU (and its larger capacity) only when one is configured.
  app.get('/api/v1/calls/topology', requireSession, (_request, response) => {
    response.json(config
      ? { sfu: { url: config.url }, meshMaxParticipants: MESH_MAX_PARTICIPANTS, sfuMaxParticipants: config.maxParticipants }
      : { sfu: null, meshMaxParticipants: MESH_MAX_PARTICIPANTS });
  });

  // A member's ticket into the group's call room on the SFU.
  app.post('/api/v1/groups/:groupId/call-token', requireSession, async (request, response) => {
    if (!config) return response.status(404).json({ error: 'Group calls through a media server are not enabled on this server.' });
    const member = await db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(request.params.groupId, request.session.user_id);
    if (!member) return response.status(404).json({ error: 'Group not found.' });
    const user = request.session.user;
    const room = roomForGroup(request.params.groupId);
    response.set('Cache-Control', 'no-store');
    response.json({
      url: config.url,
      room,
      identity: request.session.user_id,
      token: mintSfuToken(config, { identity: request.session.user_id, name: user?.name || user?.username || '', room }),
      expiresInSeconds: SFU_TOKEN_TTL_SECONDS,
    });
  });

  return { enabled: Boolean(config), config };
}
