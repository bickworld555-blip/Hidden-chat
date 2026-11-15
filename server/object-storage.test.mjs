// Attachments in S3-compatible object storage (Cloudflare R2): SigV4 against AWS's published examples, and the whole
// direct-upload path (presigned parts from the app's own upload client, completion, download redirect, HEAD, abort)
// against a fake bucket that re-verifies every signature from the request it actually received.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createChatServer } from './index.mjs';
import { createObjectStore, objectStoreConfigFromEnv, OBJECT_KEY_PREFIX, PART_BYTES, signRequest } from './objectStore.mjs';

const AWS_EXAMPLE = { endpoint: 'https://s3.amazonaws.com', bucket: 'examplebucket', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1' };
const EXAMPLE_TIME = new Date('2013-05-24T00:00:00Z');

test('SigV4 matches the AWS documentation: a presigned GET and a header-signed GET with Range', () => {
  const { url } = signRequest({ config: AWS_EXAMPLE, method: 'GET', key: 'test.txt', presign: true, expires: 86400, now: EXAMPLE_TIME, virtualHost: true });
  assert.ok(url.endsWith('X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'), url);
  const signed = signRequest({ config: AWS_EXAMPLE, method: 'GET', key: 'test.txt', headers: { range: 'bytes=0-9' }, now: EXAMPLE_TIME, virtualHost: true, payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  assert.ok(signed.headers.Authorization.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'), signed.headers.Authorization);
});

test('object storage is off unless MEDIA_STORAGE=r2, and a half configuration is refused', () => {
  assert.equal(objectStoreConfigFromEnv({}), null);
  assert.equal(objectStoreConfigFromEnv({ R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's', R2_ACCOUNT_ID: 'x' }), null, 'keys alone do not switch it on');
  assert.throws(() => objectStoreConfigFromEnv({ MEDIA_STORAGE: 'r2', R2_BUCKET: 'hm-media' }), /R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/);
  const config = objectStoreConfigFromEnv({ MEDIA_STORAGE: 'r2', R2_ACCOUNT_ID: 'abc123', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'hm-media' });
  assert.deepEqual([config.endpoint, config.region], ['https://abc123.r2.cloudflarestorage.com', 'auto']);
  assert.throws(() => objectStoreConfigFromEnv({ MEDIA_STORAGE: 'r2', R2_ACCOUNT_ID: 'x', R2_ACCESS_KEY_ID: 'a', R2_SECRET_ACCESS_KEY: 's', R2_BUCKET: 'Bad_Bucket' }), /not a valid bucket/);
});

// --- A fake S3 bucket (path style), strict about signatures ----------------------------------------------------

const objects = new Map();
const multiparts = new Map();
const log = [];
let bucketServer;
let bucketConfig;
const amzTime = (stamp) => new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);

function verifySignature(request, url) {
  const key = decodeURIComponent(url.pathname.slice(`/${bucketConfig.bucket}/`.length));
  const params = Object.fromEntries(url.searchParams);
  if (params['X-Amz-Signature']) {
    const { 'X-Amz-Signature': signature, 'X-Amz-Algorithm': _a, 'X-Amz-Credential': _c, 'X-Amz-Date': date, 'X-Amz-Expires': expires, 'X-Amz-SignedHeaders': _h, ...query } = params;
    if (amzTime(date).getTime() + Number(expires) * 1000 < Date.now()) return 'expired';
    const expected = signRequest({ config: bucketConfig, method: request.method, key, query, presign: true, expires: Number(expires), now: amzTime(date) }).url;
    return expected.endsWith(`X-Amz-Signature=${signature}`) ? null : 'bad presigned signature';
  }
  const authorization = request.headers.authorization ?? '';
  const signedNames = /SignedHeaders=([^,]+)/.exec(authorization)?.[1].split(';') ?? [];
  const headers = Object.fromEntries(signedNames.filter((name) => !['host', 'x-amz-date', 'x-amz-content-sha256'].includes(name)).map((name) => [name, request.headers[name]]));
  const expected = signRequest({ config: bucketConfig, method: request.method, key, query: params, headers, now: amzTime(request.headers['x-amz-date']), payloadHash: request.headers['x-amz-content-sha256'] });
  return expected.headers.Authorization === authorization ? null : 'bad header signature';
}

async function handleBucket(request, response) {
  const url = new URL(request.url, 'http://bucket.local');
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  const problem = verifySignature(request, url);
  const key = decodeURIComponent(url.pathname.slice(`/${bucketConfig.bucket}/`.length));
  const q = url.searchParams;
  log.push(`${request.method} ${key}${q.has('uploads') ? ' uploads' : ''}${q.has('partNumber') ? ` part${q.get('partNumber')}` : ''}${q.has('uploadId') && !q.has('partNumber') ? ' uploadId' : ''}${problem ? ` REFUSED ${problem}` : ''}`);
  if (problem) return response.writeHead(403).end(`<Error><Code>SignatureDoesNotMatch</Code></Error>`);
  if (request.method === 'POST' && q.has('uploads')) {
    const id = `mp-${multiparts.size + 1}`;
    multiparts.set(id, { key, parts: new Map() });
    return response.writeHead(200).end(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
  }
  if (request.method === 'PUT' && q.has('partNumber')) {
    const upload = multiparts.get(q.get('uploadId'));
    if (!upload) return response.writeHead(404).end();
    const etag = `"etag-${q.get('partNumber')}-${body.length}"`;
    upload.parts.set(Number(q.get('partNumber')), { etag, body });
    return response.writeHead(200, { ETag: etag }).end();
  }
  if (request.method === 'POST' && q.has('uploadId')) {
    const upload = multiparts.get(q.get('uploadId'));
    const listed = [...body.toString().matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/g)].map(([, n, etag]) => [Number(n), etag.replace(/&quot;/g, '"')]);
    if (!upload || listed.some(([n, etag]) => upload.parts.get(n)?.etag !== etag)) return response.writeHead(400).end('<Error><Code>InvalidPart</Code></Error>');
    objects.set(key, Buffer.concat(listed.map(([n]) => upload.parts.get(n).body)));
    multiparts.delete(q.get('uploadId'));
    return response.writeHead(200).end('<CompleteMultipartUploadResult></CompleteMultipartUploadResult>');
  }
  if (request.method === 'DELETE' && q.has('uploadId')) { multiparts.delete(q.get('uploadId')); return response.writeHead(204).end(); }
  if (request.method === 'PUT' && request.headers['x-amz-copy-source']) {
    const source = decodeURIComponent(request.headers['x-amz-copy-source'].slice(`/${bucketConfig.bucket}/`.length));
    if (!objects.has(source)) return response.writeHead(404).end('<Error><Code>NoSuchKey</Code></Error>');
    objects.set(key, objects.get(source));
    return response.writeHead(200).end('<CopyObjectResult></CopyObjectResult>');
  }
  if (request.method === 'HEAD') return objects.has(key) ? response.writeHead(200, { 'Content-Length': objects.get(key).length }).end() : response.writeHead(404).end();
  if (request.method === 'GET') {
    if (!objects.has(key)) return response.writeHead(404).end();
    return response.writeHead(200, { 'Content-Type': q.get('response-content-type') ?? 'application/octet-stream', 'Content-Disposition': q.get('response-content-disposition') ?? '' }).end(objects.get(key));
  }
  if (request.method === 'DELETE') { objects.delete(key); return response.writeHead(204).end(); }
  response.writeHead(400).end();
}

let service;
let directory;
let baseUrl;
let originalFetch;
before(async () => {
  bucketServer = createServer((request, response) => { handleBucket(request, response).catch(() => response.writeHead(500).end()); });
  await new Promise((resolve) => bucketServer.listen(0, '127.0.0.1', resolve));
  bucketConfig = { endpoint: `http://127.0.0.1:${bucketServer.address().port}`, bucket: 'hm-media', accessKeyId: 'test-key', secretAccessKey: 'test-secret/with+chars', region: 'auto' };
  directory = mkdtempSync(join(tmpdir(), 'relay-r2-'));
  service = createChatServer({ port: 0, host: '127.0.0.1', databasePath: join(directory, 'db.sqlite'), dataDirectory: directory, pushSender: null, objectStore: createObjectStore(bucketConfig) });
  baseUrl = `http://127.0.0.1:${(await service.listen()).port}`;
  // The app's upload client speaks to the app with relative URLs: send them to this test server.
  originalFetch = globalThis.fetch;
  globalThis.location = { href: `${baseUrl}/` };
  globalThis.fetch = (input, init) => originalFetch(typeof input === 'string' && input.startsWith('/') ? baseUrl + input : input, init);
});
after(async () => {
  globalThis.fetch = originalFetch;
  await service?.close();
  await new Promise((resolve) => bucketServer.close(resolve));
  rmSync(directory, { recursive: true, force: true });
});

async function api(path, { token, method = 'GET', body, redirect } = {}) {
  const response = await originalFetch(baseUrl + path, { method, redirect, headers: { 'X-HM-Client': '2', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await response.clone().json(); } catch { /* not JSON */ }
  return { response, status: response.status, data };
}
async function register(username) {
  const { data } = await api('/api/v1/auth/register', { method: 'POST', body: { username, dob: '1990-01-01', password: 'Correct-Horse-Battery-42!' } });
  return data;
}

test('direct upload: the app sends parts straight to the bucket, the server completes, downloads redirect to the bucket', async () => {
  const sender = await register('r2sender');
  const receiver = await register('r2receiver');
  assert.deepEqual((await api('/api/v1/uploads/config', { token: sender.token })).data, { direct: true, partBytes: PART_BYTES });

  const { uploadFile } = await import('../src/upload.js');
  const bytes = new Uint8Array(PART_BYTES + 12345).map((_, index) => index % 251);
  const progress = [];
  const result = await uploadFile(new File([bytes], 'clip ü.mp4', { type: 'video/mp4' }), { receiverId: receiver.user.id, sessionToken: sender.token, onProgress: (sent) => progress.push(sent) });
  assert.equal(result.byteSize, bytes.length);
  assert.ok(log.some((line) => line.endsWith('part2')), 'two parts went to the bucket');
  assert.ok(!log.some((line) => line.includes('REFUSED')), `every signature verified:\n${log.join('\n')}`);
  assert.deepEqual(Buffer.compare(objects.get(`${OBJECT_KEY_PREFIX}${result.id}`), Buffer.from(bytes)), 0, 'the bucket holds the exact bytes');
  assert.equal(progress.at(-1), bytes.length);

  // The receiver downloads: a redirect to a short-lived bucket URL with the name and type, never bytes from the app.
  const redirect = await api(`/api/v1/media/${result.id}`, { token: receiver.token, redirect: 'manual' });
  assert.equal(redirect.status, 302);
  const location = redirect.response.headers.get('location');
  assert.ok(location.startsWith(bucketConfig.endpoint) && location.includes('X-Amz-Signature='));
  const downloaded = await originalFetch(location);
  assert.equal(downloaded.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await downloaded.arrayBuffer()), Buffer.from(bytes)), 0);
  assert.match(downloaded.headers.get('content-disposition'), /filename\*=UTF-8''clip%20%C3%BC\.mp4/);
  const head = await api(`/api/v1/media/${result.id}`, { token: receiver.token, method: 'HEAD' });
  assert.deepEqual([head.status, head.response.headers.get('content-length')], [200, String(bytes.length)], 'HEAD is answered by the server');
  const stranger = await register('r2stranger');
  assert.equal((await api(`/api/v1/media/${result.id}`, { token: stranger.token, redirect: 'manual' })).status, 404, 'no link for people outside the chat');
});

test('direct upload: wrong parts are refused, a cancelled upload is aborted in the bucket, old clients still use the disk', async () => {
  const sender = await register('r2parts');
  const receiver = await register('r2partsto');
  const created = await api('/api/v1/uploads', { token: sender.token, method: 'POST', body: { receiverId: receiver.user.id, filename: 'a.bin', byteSize: 10, direct: true } });
  assert.deepEqual(created.data.direct, { partBytes: PART_BYTES, partCount: 1 });
  const id = created.data.uploadId;
  assert.equal((await api(`/api/v1/uploads/${id}/parts`, { token: sender.token, method: 'POST', body: { partNumbers: [2] } })).status, 400, 'no part beyond the file');
  assert.equal((await api(`/api/v1/uploads/${id}/parts`, { token: receiver.token, method: 'POST', body: { partNumbers: [1] } })).status, 404, 'only the uploader signs parts');
  assert.equal((await api(`/api/v1/uploads/${id}/complete`, { token: sender.token, method: 'POST', body: { parts: [] } })).status, 400);
  const urls = (await api(`/api/v1/uploads/${id}/parts`, { token: sender.token, method: 'POST', body: { partNumbers: [1] } })).data.urls;
  const put = await originalFetch(urls[1], { method: 'PUT', body: new Uint8Array(10) });
  assert.equal(put.status, 200);
  assert.equal((await api(`/api/v1/uploads/${id}/complete`, { token: sender.token, method: 'POST', body: { parts: [{ partNumber: 1, etag: '"forged"' }] } })).status, 400, 'the bucket refuses a part it did not store');
  assert.equal((await api(`/api/v1/uploads/${id}`, { token: sender.token, method: 'DELETE' })).status, 204);
  assert.ok(log.at(-1).startsWith(`DELETE ${OBJECT_KEY_PREFIX}${id} uploadId`), 'aborted in the bucket');

  // A client that does not ask for direct upload gets the disk path, as before.
  const legacy = await api('/api/v1/uploads', { token: sender.token, method: 'POST', body: { receiverId: receiver.user.id, filename: 'b.bin', byteSize: 4 } });
  assert.equal(legacy.data.direct, undefined);
  assert.equal(legacy.data.chunkBytes > 0, true);
});

test('object store: copy and remove (forwards and purges)', async () => {
  const store = createObjectStore(bucketConfig);
  objects.set('media/source', Buffer.from('forward me'));
  await store.copy('media/source', 'media/copy');
  assert.equal(objects.get('media/copy').toString(), 'forward me');
  assert.equal(await store.size('media/copy'), 10);
  await store.remove('media/copy');
  assert.equal(await store.size('media/copy'), null);
  await assert.rejects(store.copy('media/missing', 'media/x'), (error) => error.status === 404);
});

test('the app locates bucket-stored attachments and fetches them without its session token', async () => {
  const sender = await register('r2locate');
  const receiver = await register('r2locateto');
  const { uploadFile } = await import('../src/upload.js');
  const { fetchMediaResponse } = await import('../src/media.js');
  const sent = await uploadFile(new File([new Uint8Array([1, 2, 3, 4])], 'n.bin'), { receiverId: receiver.user.id, sessionToken: sender.token });
  const seen = [];
  const before = globalThis.fetch;
  globalThis.fetch = (input, init) => { seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') }); return before(input, init); };
  try {
    const response = await fetchMediaResponse(sent.id, receiver.token);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [1, 2, 3, 4]);
  } finally {
    globalThis.fetch = before;
  }
  assert.ok(seen[0].url.includes('?locate=1') && seen[0].auth);
  assert.ok(seen[1].url.startsWith(bucketConfig.endpoint) && seen[1].auth === null, 'no session token goes to the bucket');
});
