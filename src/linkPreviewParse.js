// Turning a fetched page into WhatsApp's link card ({ url, provider, title, description, image, siteName, video,
// duration }). Shared by the sender's phone (src/linkPreviewSender.js, which fetches pages itself) and the server's
// fallback for browsers (server/linkPreview.mjs). Pure functions: no network here.
export const MAX_HTML_BYTES = 768 * 1024;
export const CRAWLER_AGENT = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

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

export function absoluteUrl(value, base) {
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

export const clip = (text, limit) => (text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text);

export const youtubeOembedUrl = (href) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(href)}`;

/** The card from YouTube's oEmbed answer. */
export function previewFromOembed(href, data) {
  return { url: href, provider: 'youtube', title: clip(String(data?.title ?? ''), 200), description: String(data?.author_name ?? ''), image: absoluteUrl(data?.thumbnail_url, href), siteName: 'YouTube', video: true, duration: null };
}

/** The card from a page's HTML (`finalUrl` is where redirects ended), or null when the page has nothing to show. */
export function previewFromHtml(href, finalUrl, html) {
  const meta = parseMetaTags(html);
  if (!meta.title && !meta.image) return null;
  return {
    url: href,
    provider: linkProvider(href),
    title: clip(meta.title, 200),
    description: clip(meta.description, 300),
    image: absoluteUrl(meta.image, finalUrl || href),
    siteName: meta.siteName,
    video: /video/i.test(meta.type) || /\/(reel|reels|videos?|watch|share\/v|share\/r)\b/i.test(new URL(href).pathname) || meta.duration !== null,
    duration: meta.duration,
  };
}

/** A preview as it travels inside an encrypted message: only known fields, bounded, thumbnail as a small data URL. */
export function sanitizePreview(value) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') return null;
  const text = (field, limit) => (typeof value[field] === 'string' ? clip(value[field], limit) : '');
  const thumbnail = typeof value.thumbnail === 'string' && /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(value.thumbnail) && value.thumbnail.length <= 24_000
    ? value.thumbnail : '';
  return {
    url: value.url.slice(0, 2048),
    provider: text('provider', 20),
    title: text('title', 200),
    description: text('description', 300),
    siteName: text('siteName', 80),
    video: value.video === true,
    duration: Number.isFinite(value.duration) && value.duration > 0 ? Math.round(value.duration) : null,
    thumbnail,
  };
}
