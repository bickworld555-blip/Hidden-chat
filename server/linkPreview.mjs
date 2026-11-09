// Link previews for shared links (Facebook reels and videos, YouTube, Instagram, news…), like WhatsApp's card: a
// thumbnail, title, description and the site. YouTube answers through its oEmbed API; other sites through the
// Open Graph tags in their page (Facebook serves those to its own link crawler's user agent).
//
// The server fetches what users send, so only public http(s) addresses are fetched: every hop of a redirect is
// checked, private, loopback and link-local addresses are refused, and the read is capped in time and size.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 768 * 1024;
const MAX_REDIRECTS = 4;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 1000;
const CRAWLER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

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

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
    if (code[0] === '#') {
      const value = code[1].toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

// Open Graph / Twitter / plain meta tags of a page: { title, description, image, siteName, type, duration }.
export function parseMetaTags(html) {
  const head = String(html).slice(0, MAX_HTML_BYTES);
  const meta = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = /\b(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const content = /\bcontent\s*=\s*"([^"]*)"|\bcontent\s*=\s*'([^']*)'/i.exec(tag);
    if (key && content && !(key in meta)) meta[key] = decodeEntities(content[1] ?? content[2]).trim();
  }
  const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1];
  const duration = Number(meta['video:duration'] ?? meta['og:video:duration'] ?? NaN);
  return {
    title: meta['og:title'] || meta['twitter:title'] || decodeEntities(titleTag ?? '').trim() || '',
    description: meta['og:description'] || meta['twitter:description'] || meta.description || '',
    image: meta['og:image:secure_url'] || meta['og:image'] || meta['twitter:image'] || meta['twitter:image:src'] || '',
    siteName: meta['og:site_name'] || '',
    type: meta['og:type'] || '',
    duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
  };
}

// Which platform a link belongs to, for its icon and its "video" look.
export function linkProvider(href) {
  let host = '';
  try { host = new URL(href).hostname.toLowerCase().replace(/^www\.|^m\.|^web\./, ''); } catch { return ''; }
  if (/(^|\.)(facebook\.com|fb\.watch|fb\.com)$/.test(host)) return 'facebook';
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return 'youtube';
  if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
  if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
  if (/(^|\.)(x\.com|twitter\.com)$/.test(host)) return 'x';
  return '';
}

function absolute(value, base) {
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);

export function createLinkPreviews({ fetchImpl = fetch, resolve = lookup, now = () => Date.now() } = {}) {
  const cache = new Map();

  async function load(href) {
    const provider = linkProvider(href);
    if (provider === 'youtube') {
      const oembed = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(href)}`;
      const { response } = await fetchPublic(oembed, { resolve, fetchImpl });
      if (!response.ok) return null;
      const data = JSON.parse(await readCapped(response));
      return { url: href, provider, title: clip(String(data.title ?? ''), 200), description: String(data.author_name ?? ''), image: absolute(data.thumbnail_url, href), siteName: 'YouTube', video: true, duration: null };
    }
    const { response, url } = await fetchPublic(href, { resolve, fetchImpl, headers: { 'User-Agent': CRAWLER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' } });
    if (!response.ok || !/html/i.test(response.headers.get('content-type') ?? '')) return null;
    const meta = parseMetaTags(await readCapped(response));
    if (!meta.title && !meta.image) return null;
    return {
      url: href,
      provider,
      title: clip(meta.title, 200),
      description: clip(meta.description, 300),
      image: absolute(meta.image, url),
      siteName: meta.siteName,
      video: /video/i.test(meta.type) || /\/(reel|reels|videos?|watch|share\/v|share\/r)\b/i.test(new URL(href).pathname) || meta.duration !== null,
      duration: meta.duration,
    };
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
