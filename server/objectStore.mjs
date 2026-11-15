// S3-compatible object storage for attachments (Cloudflare R2 in production; any S3 API works), with AWS Signature
// Version 4 implemented on node:crypto (no SDK). Phones upload and download straight to the bucket with short-lived
// presigned URLs, so attachment bytes no longer pass through the app server; the server only signs, completes,
// copies and deletes.
//
// Off unless MEDIA_STORAGE=r2 and the four R2_* variables are set; attachments then stay on local disk as before.
import { createHash, createHmac } from 'node:crypto';

// R2 accepts multipart parts of 5 MiB to 5 GiB (the last part may be smaller) and up to 10,000 parts.
export const MIN_PART_BYTES = 5 * 1024 * 1024;
export const PART_BYTES = 8 * 1024 * 1024;
export const MAX_PARTS = 10_000;
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;
// Object keys of attachments (media rows with storage = 'r2'); disk files are "<id>.blob" and never contain "/".
export const OBJECT_KEY_PREFIX = 'media/';

/** The bucket configuration from the environment, or null (attachments on local disk). Throws when half-configured. */
export function objectStoreConfigFromEnv(env = process.env) {
  if ((env.MEDIA_STORAGE ?? 'disk').trim().toLowerCase() !== 'r2') return null;
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET?.trim();
  const endpoint = (env.R2_ENDPOINT?.trim() || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, '');
  const missing = [['R2_ACCESS_KEY_ID', accessKeyId], ['R2_SECRET_ACCESS_KEY', secretAccessKey], ['R2_BUCKET', bucket], ['R2_ACCOUNT_ID or R2_ENDPOINT', endpoint]].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`MEDIA_STORAGE=r2 needs ${missing.join(', ')}.`);
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('R2_BUCKET is not a valid bucket name.');
  return { endpoint, bucket, accessKeyId, secretAccessKey, region: env.R2_REGION?.trim() || 'auto' };
}

const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding as SigV4 requires (encodeURIComponent leaves !'()* alone).
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (path) => path.split('/').map(encode).join('/');
const amzDate = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function signingKey(secret, day, region, service) {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, day), region), service), 'aws4_request');
}

/**
 * Signs one request (SigV4). `presign` puts the signature in the query (a URL anyone can use until it expires);
 * otherwise it returns the Authorization headers. `virtualHost` addresses the bucket as a host name (AWS style);
 * R2 uses path style. Pure: `now` is passed in, so the AWS documentation's example can be checked exactly.
 */
export function signRequest({ config, method, key, query = {}, headers = {}, presign = false, expires = DOWNLOAD_URL_TTL_SECONDS, now = new Date(), virtualHost = false, payloadHash = 'UNSIGNED-PAYLOAD' }) {
  const base = new URL(config.endpoint);
  const host = virtualHost ? `${config.bucket}.${base.host}` : base.host;
  const path = virtualHost ? `/${encodePath(key)}` : `${base.pathname.replace(/\/$/, '')}/${config.bucket}/${encodePath(key)}`;
  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);
  const scope = `${day}/${config.region}/s3/aws4_request`;
  const signedHeaders = { host, ...Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim()])) };
  if (!presign) Object.assign(signedHeaders, { 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp });
  const headerNames = Object.keys(signedHeaders).sort();
  const params = { ...query };
  if (presign) {
    Object.assign(params, {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${config.accessKeyId}/${scope}`, 'X-Amz-Date': stamp,
      'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': headerNames.join(';'),
    });
  }
  const canonicalQuery = Object.keys(params).sort().map((name) => `${encode(name)}=${encode(params[name] ?? '')}`).join('&');
  const canonical = [method, path, canonicalQuery, headerNames.map((name) => `${name}:${signedHeaders[name]}\n`).join(''), headerNames.join(';'), presign ? 'UNSIGNED-PAYLOAD' : payloadHash].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(canonical)].join('\n');
  const signature = createHmac('sha256', signingKey(config.secretAccessKey, day, config.region, 's3')).update(toSign).digest('hex');
  const url = `${base.protocol}//${host}${path}`;
  if (presign) return { url: `${url}?${canonicalQuery}&X-Amz-Signature=${signature}` };
  const { host: _host, ...sent } = signedHeaders;
  return {
    url: canonicalQuery ? `${url}?${canonicalQuery}` : url,
    headers: { ...sent, Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${headerNames.join(';')}, Signature=${signature}` },
  };
}

const xmlValue = (xml, tag) => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1] ?? null;
const xmlEscape = (value) => String(value).replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char]);
const asciiFilename = (name) => String(name).replace(/[^\x20-\x7e]|["\\]/g, '_');

/** The bucket's operations. Every failure is an Error with `status` (the bucket's HTTP status) when there was one. */
export function createObjectStore(config, { fetchImpl = globalThis.fetch, now = () => new Date() } = {}) {
  async function call(method, key, { query = {}, headers = {}, body, expect = [200] } = {}) {
    const payloadHash = body === undefined ? sha256Hex('') : sha256Hex(body);
    const signed = signRequest({ config, method, key, query, headers, now: now(), payloadHash });
    const response = await fetchImpl(signed.url, { method, headers: signed.headers, body });
    const text = method === 'HEAD' ? '' : await response.text();
    if (!expect.includes(response.status)) {
      throw Object.assign(new Error(`Object storage ${method} failed (${response.status} ${xmlValue(text, 'Code') ?? ''})`.trim()), { status: response.status });
    }
    return { response, text };
  }

  return {
    config,
    async createMultipart(key, contentType) {
      const { text } = await call('POST', key, { query: { uploads: '' }, headers: { 'content-type': contentType || 'application/octet-stream' } });
      const uploadId = xmlValue(text, 'UploadId');
      if (!uploadId) throw new Error('Object storage did not start the upload.');
      return uploadId;
    },
    /** A URL the phone PUTs one part to; the response's ETag header identifies the part. */
    presignPart(key, uploadId, partNumber) {
      return signRequest({ config, method: 'PUT', key, query: { partNumber: String(partNumber), uploadId }, presign: true, expires: UPLOAD_URL_TTL_SECONDS, now: now() }).url;
    },
    async completeMultipart(key, uploadId, parts) {
      const body = `<CompleteMultipartUpload>${parts.map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(part.etag)}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
      const { text } = await call('POST', key, { query: { uploadId }, headers: { 'content-type': 'application/xml' }, body });
      // S3 can answer 200 with an error document.
      if (/<Error>/.test(text)) throw Object.assign(new Error(`Object storage could not complete the upload (${xmlValue(text, 'Code') ?? 'error'}).`), { status: 400 });
    },
    async abortMultipart(key, uploadId) {
      await call('DELETE', key, { query: { uploadId }, expect: [204, 200, 404] });
    },
    /** The stored size in bytes, or null when the object does not exist. */
    async size(key) {
      const { response } = await call('HEAD', key, { expect: [200, 404] });
      return response.status === 404 ? null : Number(response.headers.get('content-length'));
    },
    async remove(key) {
      await call('DELETE', key, { expect: [204, 200, 404] });
    },
    async copy(fromKey, toKey) {
      const { text } = await call('PUT', toKey, { headers: { 'x-amz-copy-source': `/${config.bucket}/${encodePath(fromKey)}` } });
      if (/<Error>/.test(text)) throw Object.assign(new Error('Object storage could not copy the attachment.'), { status: 400 });
    },
    /** A short-lived download URL that also tells the browser the file's type and name. */
    presignDownload(key, { contentType, filename, inline = false, expires = DOWNLOAD_URL_TTL_SECONDS } = {}) {
      const query = {
        ...(contentType ? { 'response-content-type': contentType } : {}),
        ...(filename ? { 'response-content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encode(filename)}` } : {}),
        'response-cache-control': 'private, no-store',
      };
      return signRequest({ config, method: 'GET', key, query, presign: true, expires, now: now() }).url;
    },
  };
}
