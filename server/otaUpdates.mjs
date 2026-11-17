// Over-the-air web updates (OTA): stores and serves signed web bundles for the Android app (OtaUpdates.java).
//
// - GET /ota/manifest.json: { payload, signature }. `payload` is the bundle's JSON text (version, nativeApi, files with
//   SHA-256 and size); `signature` is ECDSA P-256 / SHA-256 (DER, base64) over its UTF-8 bytes. Phones verify it with
//   the public key built into the app, so the server cannot change what phones run: it only stores and serves.
// - GET /ota/files/<sha256>: file contents by hash (immutable). A phone downloads only files it does not already have.
// - Publishing (scripts/ota-publish.mjs, admins): PUT /api/admin/v1/ota/files/<sha256> (raw bytes, checked against the
//   hash), then PUT /api/admin/v1/ota/manifest (refused unless the signature verifies and every file is present).
// Files live in <data directory>/ota, which survives deploys.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import express from 'express';
import { OTA_MAX_FILE_BYTES, OTA_PUBLIC_KEY, parseOtaPayload } from '../src/otaConfig.js';

const SHA = /^[0-9a-f]{64}$/;

export function verifyOtaManifest(manifest, publicKey = OTA_PUBLIC_KEY) {
  if (!manifest || typeof manifest.payload !== 'string' || typeof manifest.signature !== 'string') return null;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    if (!verify('sha256', Buffer.from(manifest.payload, 'utf8'), key, Buffer.from(manifest.signature, 'base64'))) return null;
  } catch {
    return null;
  }
  return parseOtaPayload(manifest.payload);
}

export function registerOtaUpdates({ app, dataDirectory, requireAdmin, publicKey = OTA_PUBLIC_KEY }) {
  const root = join(dataDirectory, 'ota');
  const files = join(root, 'files');
  const manifestPath = join(root, 'manifest.json');
  mkdirSync(files, { recursive: true });

  app.get('/ota/manifest.json', async (_request, response) => {
    response.set('Cache-Control', 'no-cache');
    if (!existsSync(manifestPath)) return response.status(404).json({ error: 'No update published.' });
    response.type('application/json').send(await readFile(manifestPath));
  });

  app.get('/ota/files/:sha', (request, response) => {
    const { sha } = request.params;
    if (!SHA.test(sha)) return response.status(400).end();
    response.set('Cache-Control', 'public, max-age=31536000, immutable');
    response.sendFile(join(files, sha), { headers: { 'Content-Type': 'application/octet-stream' } }, (error) => {
      if (error && !response.headersSent) response.status(error.status === 404 || error.code === 'ENOENT' ? 404 : 500).end();
    });
  });

  app.get('/api/admin/v1/ota', requireAdmin, async (_request, response) => {
    if (!existsSync(manifestPath)) return response.json({ published: null });
    const payload = parseOtaPayload(JSON.parse(await readFile(manifestPath, 'utf8')).payload);
    response.json({ published: payload && { version: payload.version, nativeApi: payload.nativeApi, createdAt: payload.createdAt, files: payload.files.length } });
  });

  app.head('/api/admin/v1/ota/files/:sha', requireAdmin, async (request, response) => {
    if (!SHA.test(request.params.sha)) return response.status(400).end();
    response.status(existsSync(join(files, request.params.sha)) ? 200 : 404).end();
  });

  app.put('/api/admin/v1/ota/files/:sha', requireAdmin, express.raw({ type: () => true, limit: OTA_MAX_FILE_BYTES }), async (request, response) => {
    const { sha } = request.params;
    if (!SHA.test(sha) || !Buffer.isBuffer(request.body)) return response.status(400).json({ error: 'A file is uploaded by its SHA-256.' });
    if (createHash('sha256').update(request.body).digest('hex') !== sha) return response.status(400).json({ error: 'The file does not match its SHA-256.' });
    const target = join(files, sha);
    if (!existsSync(target)) {
      const temporary = `${target}.${process.pid}.part`;
      await writeFile(temporary, request.body);
      await rename(temporary, target);
    }
    response.status(204).end();
  });

  app.put('/api/admin/v1/ota/manifest', requireAdmin, express.json({ limit: '1mb' }), async (request, response) => {
    const payload = verifyOtaManifest(request.body, publicKey);
    if (!payload) return response.status(400).json({ error: 'The manifest is not signed with the OTA key, or is not a valid bundle.' });
    for (const file of payload.files) {
      const present = await stat(join(files, file.sha256)).catch(() => null);
      if (!present || present.size !== file.size) return response.status(409).json({ error: `File ${file.path} (${file.sha256}) is not uploaded.` });
    }
    const temporary = `${manifestPath}.part`;
    await writeFile(temporary, JSON.stringify({ payload: request.body.payload, signature: request.body.signature }));
    await rename(temporary, manifestPath);
    response.json({ version: payload.version, files: payload.files.length });
  });

  // Withdraw the published bundle (phones keep what they have; a bad one is rolled back by the phone itself).
  app.delete('/api/admin/v1/ota/manifest', requireAdmin, async (_request, response) => {
    await rm(manifestPath, { force: true });
    response.status(204).end();
  });
}
