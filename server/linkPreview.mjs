// Link previews for shared links (Facebook reels and videos, YouTube, Instagram, news…), like WhatsApp's card: a
// thumbnail, title, description and the site. YouTube answers through its oEmbed API; other sites through the
// Open Graph tags in their page (Facebook serves those to its own link crawler's user agent).
//
// The server fetches what users send, so only public http(s) addresses are fetched: every hop of a redirect is
// checked, private, loopback and link-local addresses are refused, and the read is capped in time and size.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { CRAWLER_AGENT, MAX_HTML_BYTES, linkProvider, previewFromHtml, previewFromOembed, youtubeOembedUrl } from '../src/linkPreviewParse.js';

// The parser is shared with the sender's phone, which builds previews itself (src/linkPreviewParse.js).
export { decodeEntities, linkProvider, parseMetaTags } from '../src/linkPreviewParse.js';

const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 4;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 1000;

export function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (version === 6) {
    const value = address.toLowerCase();
    if (value === '::' || value === '::1') return true;
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(value);
  }
  return true;
}

async function assertPublic(url, resolve = lookup) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only web links have previews.');
  if (url.username || url.password) throw new Error('Links with credentials are not previewed.');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Only standard web ports are previewed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
  if (!addresses.length || addresses.some((entry) => isPrivateAddress(entry.address))) throw new Error('That address is not public.');
}

async function fetchPublic(rawUrl, { headers = {}, resolve = lookup, fetchImpl = fetch } = {}) {
  let url = new URL(rawUrl);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertPublic(url, resolve);
    const response = await fetchImpl(url, { redirect: 'manual', headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      url = new URL(response.headers.get('location'), url);
      continue;
    }
    return { response, url };
  }
  throw new Error('Too many redirects.');
}

async function readCapped(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_HTML_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

export function createLinkPreviews({ fetchImpl = fetch, resolve = lookup, now = () => Date.now() } = {}) {
  const cache = new Map();

  async function load(href) {
    const provider = linkProvider(href);
    if (provider === 'youtube') {
      const { response } = await fetchPublic(youtubeOembedUrl(href), { resolve, fetchImpl });
      if (!response.ok) return null;
      return previewFromOembed(href, JSON.parse(await readCapped(response)));
    }
    const { response, url } = await fetchPublic(href, { resolve, fetchImpl, headers: { 'User-Agent': CRAWLER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' } });
    if (!response.ok || !/html/i.test(response.headers.get('content-type') ?? '')) return null;
    return previewFromHtml(href, url, await readCapped(response));
  }

  return async function preview(href) {
    const key = new URL(href).href;
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.value;
    let value = null;
    try {
      value = await load(key);
    } catch {
      value = null;
    }
    cache.set(key, { value, expiresAt: now() + (value ? CACHE_TTL_MS : MISS_TTL_MS) });
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    return value;
  };
}
