// Linking a browser to your phone by scanning a QR code (like web.whatsapp.com).
//
//   1. The browser asks for a link request: it gets an id, a secret and a short code, and shows a QR code
//      holding the id, the secret and the browser's own public key (for the history it will receive).
//   2. The signed-in phone scans it (or types the code) and approves: the server creates a new session (a new
//      device) for that account and hands it to the waiting browser, once.
//   3. The phone then streams the chat history encrypted to the browser's public key (src/linking.js) in numbered
//      parts: the newest messages of every chat first, then older ones until everything moved. The server only
//      relays ciphertext, holds at most MAX_PENDING_PARTS parts at a time (the phone waits on 429), and forgets
//      each part once the browser fetched it. The history window stays open while parts keep flowing.
//   With the typed code instead of the QR, the browser's key reaches the phone through the server, so the phone
//   shows its security code (src/linking.js keyFingerprint) to compare with the browser's screen before sending.
// Requests live in memory for LINK_TTL_MS: nothing about a pending link survives a restart.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';

export const LINK_TTL_MS = 3 * 60 * 1000;
export const HISTORY_TTL_MS = 5 * 60 * 1000;
export const MAX_PENDING_LINKS = 2000;
export const MAX_HISTORY_BYTES = 12 * 1024 * 1024;
export const WAIT_MS = 25_000;
export const MAX_PENDING_PARTS = 4;
export const MAX_PARTS = 2000;
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const KEY = /^[A-Za-z0-9+/]{87}=$/;

const hash = (value) => createHash('sha256').update(String(value)).digest();
const sameSecret = (secret, expected) => typeof secret === 'string' && secret.length === 22 && timingSafeEqual(hash(secret), expected);

export function linkCode(random = randomBytes) {
  const bytes = random(8);
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

export function registerLinking({ app, requireSession, issueSession, suspended, now = () => Date.now() }) {
  const requests = new Map();
  const byCode = new Map();

  function sweep() {
    const time = now();
    for (const [id, item] of requests) {
      const limit = item.status === 'approved' ? item.activeAt + HISTORY_TTL_MS : item.createdAt + LINK_TTL_MS;
      if (time > limit) {
        requests.delete(id);
        byCode.delete(item.code);
        for (const waiter of item.waiters) waiter();
      }
    }
  }
  const timer = setInterval(sweep, 30_000);
  timer.unref?.();

  function find(id, secret) {
    sweep();
    const item = requests.get(id);
    return item && sameSecret(secret, item.secretHash) ? item : null;
  }

  // Browser: start a link request.
  app.post('/api/v1/link/requests', (request, response) => {
    sweep();
    if (requests.size >= MAX_PENDING_LINKS) return response.status(503).json({ error: 'Too many devices are linking right now. Try again in a minute.' });
    const publicKey = typeof request.body?.publicKey === 'string' && KEY.test(request.body.publicKey) ? request.body.publicKey : null;
    const deviceName = typeof request.body?.deviceName === 'string' ? request.body.deviceName.trim().slice(0, 60) : '';
    const id = randomBytes(12).toString('base64url');
    const secret = randomBytes(16).toString('base64url');
    let code = linkCode();
    while (byCode.has(code)) code = linkCode();
    const item = { id, code, secretHash: hash(secret), publicKey, deviceName: deviceName || 'Web browser', createdAt: now(), status: 'pending', session: null, parts: new Map(), finalPart: null, ownerId: null, waiters: new Set() };
    requests.set(id, item);
    byCode.set(code, id);
    response.status(201).json({ id, secret, code, expiresAt: item.createdAt + LINK_TTL_MS });
  });

  // Browser: wait (long poll) until the phone approves. The session is handed over exactly once.
  app.get('/api/v1/link/requests/:id', async (request, response) => {
    let item = find(request.params.id, request.query.secret);
    if (!item) return response.status(404).json({ error: 'This QR code expired. Refresh it to try again.' });
    if (item.status === 'pending') {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timeout); item.waiters.delete(done); resolve(); };
        const timeout = setTimeout(done, WAIT_MS);
        item.waiters.add(done);
        request.on('close', done);
      });
      item = requests.get(request.params.id);
      if (!item) return response.status(404).json({ error: 'This QR code expired. Refresh it to try again.' });
    }
    if (item.status !== 'approved' || !item.session) return response.json({ status: item.status });
    const session = item.session;
    item.session = null;
    response.json({ status: 'approved', session, history: Boolean(item.publicKey) });
  });

  // Phone: what is about to be linked (from the scanned QR or the typed code).
  app.post('/api/v1/link/lookup', requireSession, (request, response) => {
    sweep();
    const fromCode = typeof request.body?.code === 'string' ? byCode.get(request.body.code.toUpperCase().replace(/[^A-Z0-9]/g, '')) : null;
    const item = fromCode ? requests.get(fromCode) : find(request.body?.id, request.body?.secret);
    if (!item || item.status !== 'pending') return response.status(404).json({ error: 'This code expired or was already used. Ask for a new one on the other device.' });
    // The browser's key, so the phone can show its security code (compared by eye on the typed-code path).
    response.json({ id: item.id, deviceName: item.deviceName, createdAt: item.createdAt, publicKey: item.publicKey });
  });

  // Phone: approve. Either the QR's secret or the typed code proves the phone saw the browser's screen.
  app.post('/api/v1/link/requests/:id/approve', requireSession, async (request, response) => {
    sweep();
    const item = requests.get(request.params.id);
    const viaSecret = item && sameSecret(request.body?.secret, item.secretHash);
    const viaCode = item && typeof request.body?.code === 'string' && request.body.code.toUpperCase().replace(/[^A-Z0-9]/g, '') === item.code;
    if (!item || (!viaSecret && !viaCode) || item.status !== 'pending') return response.status(404).json({ error: 'This code expired or was already used.' });
    const userId = request.session.user_id;
    if (await suspended(userId)) return response.status(403).json({ error: 'This account is suspended.' });
    item.status = 'approved';
    item.approvedAt = now();
    item.activeAt = item.approvedAt;
    item.ownerId = userId;
    item.session = await issueSession(userId, item.deviceName);
    byCode.delete(item.code);
    for (const waiter of item.waiters) waiter();
    // keySource tells the phone how far to trust the key: "qr" came with the scanned code; "code" came through
    // this server and is only used after the person compared security codes on both screens.
    response.json({ linked: true, deviceName: item.deviceName, historyKey: item.publicKey, keySource: viaSecret ? 'qr' : 'code' });
  });

  const partNumber = (value, fallback) => {
    if (value === undefined) return fallback;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number < MAX_PARTS ? number : null;
  };

  // Phone: one encrypted part of the history (?part=n, &final=1 on the last). Without ?part (older apps) it is
  // part 0 and the only one. Ciphertext only, at most MAX_HISTORY_BYTES per part.
  app.put('/api/v1/link/requests/:id/history', requireSession, express.json({ limit: MAX_HISTORY_BYTES }), (request, response) => {
    const item = requests.get(request.params.id);
    if (!item || item.ownerId !== request.session.user_id || !item.publicKey) return response.status(404).json({ error: 'Link not found.' });
    const part = partNumber(request.query.part, 0);
    const final = request.query.part === undefined || request.query.final === '1';
    const { ephemeralKey, iv, data } = request.body ?? {};
    if (part === null || !KEY.test(ephemeralKey ?? '') || typeof iv !== 'string' || typeof data !== 'string' || data.length > MAX_HISTORY_BYTES) return response.status(400).json({ error: 'Invalid history.' });
    if (item.finalPart !== null && part > item.finalPart) return response.status(400).json({ error: 'The history already ended.' });
    if (!item.parts.has(part) && item.parts.size >= MAX_PENDING_PARTS) return response.status(429).json({ error: 'The new device is still catching up. Try this part again shortly.' });
    item.parts.set(part, { ephemeralKey, iv, data });
    if (final) item.finalPart = part;
    item.activeAt = now();
    for (const waiter of item.waiters) waiter();
    response.status(204).end();
  });

  // Browser: fetch part n (?part=n, default 0) once it arrived (long poll), then it is forgotten. The response says
  // whether it was the last part; after the last one the whole request is gone.
  app.get('/api/v1/link/requests/:id/history', async (request, response) => {
    let item = find(request.params.id, request.query.secret);
    if (!item || item.status !== 'approved') return response.status(404).json({ error: 'Link not found.' });
    const part = partNumber(request.query.part, 0);
    if (part === null) return response.status(400).json({ error: 'Invalid part.' });
    if (!item.parts.has(part) && !(item.finalPart !== null && part > item.finalPart)) {
      await new Promise((resolve) => {
        const done = () => { clearTimeout(timeout); item.waiters.delete(done); resolve(); };
        const timeout = setTimeout(done, WAIT_MS);
        item.waiters.add(done);
        request.on('close', done);
      });
      item = requests.get(request.params.id);
    }
    if (!item) return response.status(404).json({ error: 'Link not found.' });
    if (item.finalPart !== null && part > item.finalPart) return response.status(410).json({ error: 'The history is complete.' });
    const sealed = item.parts.get(part);
    if (!sealed) return response.status(204).end();
    item.parts.delete(part);
    item.activeAt = now();
    const final = item.finalPart === part;
    if (final || request.query.part === undefined) requests.delete(item.id);
    for (const waiter of item.waiters) waiter();
    response.json({ ...sealed, part, final });
  });

  return { close: () => clearInterval(timer), pending: () => requests.size };
}
