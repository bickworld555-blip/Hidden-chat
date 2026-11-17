// Call telemetry (src/callTelemetry.js sends it): per call connection, round trip, loss, jitter, incoming picture,
// voice packets vs seconds played, restarts, network path and push-to-ring time. Kept CALL_TELEMETRY_RETENTION_MS
// and read by admins (GET /api/admin/v1/call-telemetry), so call faults are visible without a phone on USB.
// Numbers only: no content, no names; ids as the server already sees them in call signalling.
import { randomUUID } from 'node:crypto';
import express from 'express';

export const CALL_TELEMETRY_RETENTION_MS = 30 * 24 * 3600_000;
export const CALL_TELEMETRY_MAX_PAIRS = 8;
// A call sends one report every 30 s and one at the end; this bounds a misbehaving app (two hours of reports).
export const CALL_TELEMETRY_HOURLY_LIMIT = 240;
// The admin summary counts a call as ringing promptly within this time (WhatsApp-class target).
export const RING_TARGET_MS = 3000;

export function ensureCallTelemetrySchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS call_telemetry (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, call_id TEXT NOT NULL, final INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, report TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS call_telemetry_created ON call_telemetry(created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS call_telemetry_user ON call_telemetry(user_id, created_at)');
}

const num = (value, max, digits = 0) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  const scale = 10 ** digits;
  return Math.round(Math.min(n, max) * scale) / scale;
};
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

/** The stored form of a report, or null when it is not one. Unknown fields are dropped; numbers are bounded. */
export function cleanCallTelemetry(body) {
  if (!body || typeof body !== 'object' || typeof body.callId !== 'string' || !body.callId || body.callId.length > 80) return null;
  if (!Array.isArray(body.pairs) || body.pairs.length === 0) return null;
  return {
    callId: body.callId,
    roomId: text(body.roomId, 80),
    mode: body.mode === 'video' ? 'video' : 'audio',
    direction: body.direction === 'incoming' ? 'incoming' : 'outgoing',
    group: Boolean(body.group),
    final: Boolean(body.final),
    pairs: body.pairs.slice(0, CALL_TELEMETRY_MAX_PAIRS).filter((pair) => pair && typeof pair === 'object').map((pair) => ({
      peerId: text(pair.peerId, 80),
      status: text(pair.status, 16),
      rttMs: num(pair.rttMs, 60_000),
      loss: num(pair.loss, 1, 4),
      jitterMs: num(pair.jitterMs, 10_000),
      fps: num(pair.fps, 120),
      width: num(pair.width, 8192),
      height: num(pair.height, 8192),
      audioPackets: num(pair.audioPackets, Number.MAX_SAFE_INTEGER),
      audioPlayedS: num(pair.audioPlayedS, 24 * 3600, 1),
      path: pair.path === 'relay' || pair.path === 'direct' ? pair.path : null,
      iceRestarts: num(pair.iceRestarts, 1000),
      playoutRestarts: num(pair.playoutRestarts, 1000),
      red: Boolean(pair.red),
      ringMs: num(pair.ringMs, 120_000),
      ringVia: pair.ringVia === 'push' || pair.ringVia === 'socket' ? pair.ringVia : null,
      pushMs: num(pair.pushMs, 120_000),
      ringServerMs: num(pair.ringServerMs, 120_000),
      connectedMs: num(pair.connectedMs, 24 * 3600_000),
    })),
  };
}

/** Figures over final reports: calls, share that rang within RING_TARGET_MS, voice-output restarts, relay share. */
export function summarizeCallTelemetry(reports) {
  const pairs = reports.filter((report) => report.final).flatMap((report) => report.pairs);
  const rang = pairs.filter((pair) => pair.ringMs != null);
  return {
    calls: new Set(reports.filter((report) => report.final).map((report) => report.callId)).size,
    connections: pairs.length,
    ringWithinTarget: rang.length ? Math.round((rang.filter((pair) => pair.ringMs <= RING_TARGET_MS).length / rang.length) * 1000) / 1000 : null,
    connectionsWithPlayoutRestart: pairs.filter((pair) => (pair.playoutRestarts ?? 0) > 0).length,
    relayShare: pairs.length ? Math.round((pairs.filter((pair) => pair.path === 'relay').length / pairs.length) * 1000) / 1000 : null,
    // How calls reached the other phone: a push that had to wake it, or the app already connected.
    ringedByPush: rang.filter((pair) => pair.ringVia === 'push').length,
    ringedBySocket: rang.filter((pair) => pair.ringVia === 'socket').length,
  };
}

export function registerCallTelemetry({ app, db, requireSession, requireAdmin, now = () => Date.now() }) {
  let lastSweep = 0;
  const sweep = async () => {
    if (now() - lastSweep < 3600_000) return;
    lastSweep = now();
    await db.prepare('DELETE FROM call_telemetry WHERE created_at < ?').run(now() - CALL_TELEMETRY_RETENTION_MS);
  };

  app.post('/api/v1/calls/telemetry', requireSession, express.json({ limit: '16kb' }), async (request, response) => {
    const report = cleanCallTelemetry(request.body);
    if (!report) return response.status(400).json({ error: 'Call telemetry is invalid.' });
    const userId = request.session.user_id;
    const recent = await db.prepare('SELECT COUNT(*) AS count FROM call_telemetry WHERE user_id = ? AND created_at > ?').get(userId, now() - 3600_000);
    if (Number(recent?.count ?? 0) >= CALL_TELEMETRY_HOURLY_LIMIT) return response.status(429).json({ error: 'Too many call reports.' });
    await db.prepare('INSERT INTO call_telemetry (id, user_id, call_id, final, created_at, report) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), userId, report.callId, report.final ? 1 : 0, now(), JSON.stringify(report));
    sweep().catch(() => {});
    return response.status(204).end();
  });

  // Admins: the newest reports (optionally one user's or one call's) and the summary over them.
  app.get('/api/admin/v1/call-telemetry', requireAdmin, async (request, response) => {
    const limit = Math.min(500, Math.max(1, Number.parseInt(request.query.limit, 10) || 100));
    const userId = typeof request.query.userId === 'string' ? request.query.userId : null;
    const callId = typeof request.query.callId === 'string' ? request.query.callId : null;
    const where = [];
    const params = [];
    if (userId) { where.push('user_id = ?'); params.push(userId); }
    if (callId) { where.push('call_id = ?'); params.push(callId); }
    const rows = await db.prepare(`SELECT user_id AS "userId", created_at AS "createdAt", report FROM call_telemetry
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ${limit}`).all(...params);
    const reports = rows.map((row) => ({ userId: row.userId, createdAt: Number(row.createdAt), ...JSON.parse(row.report) }));
    response.json({ summary: summarizeCallTelemetry(reports), reports });
  });
}
