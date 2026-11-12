// GIF search through GIPHY, proxied like Signal's: the app asks this server, which asks GIPHY with the server's API
// key, and the GIF images come through this server too. GIPHY therefore never sees a user's IP address, and a GIF
// that is sent travels as an ordinary end-to-end encrypted attachment (the recipient never contacts GIPHY).
// Off unless GIPHY_API_KEY is set.
const SEARCH_URL = 'https://api.giphy.com/v1/gifs/search';
const TRENDING_URL = 'https://api.giphy.com/v1/gifs/trending';
export const GIF_PAGE_SIZE = 24;
const MAX_QUERY = 50;
const MAX_OFFSET = 499; // GIPHY's search caps offset at 499
const CACHE_MS = 10 * 60 * 1000;
const CACHE_ENTRIES = 300;
export const MAX_GIF_BYTES = 8 * 1024 * 1024;
const REQUESTS_PER_MINUTE = 60;
// Only GIPHY's media hosts can be fetched through the proxy.
const MEDIA_HOST = /^(?:media\d*|i)\.giphy\.com$/;
const MEDIA_TYPES = new Set(['image/gif', 'image/webp']);

export function gifConfigFromEnv(env = process.env) {
  const apiKey = typeof env.GIPHY_API_KEY === 'string' ? env.GIPHY_API_KEY.trim() : '';
  return apiKey ? { apiKey, rating: env.GIPHY_RATING?.trim() || 'pg-13' } : null;
}

/** A GIPHY media address the proxy may fetch, or null. */
export function allowedMediaUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && MEDIA_HOST.test(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** GIPHY's answer → what the app shows: a small preview to pick from and the GIF that is sent. */
export function presentGifs(body) {
  return (Array.isArray(body?.data) ? body.data : []).map((item) => {
    const preview = item?.images?.fixed_width_small ?? item?.images?.fixed_width;
    const full = item?.images?.downsized ?? item?.images?.original;
    const previewUrl = allowedMediaUrl(preview?.url);
    const fullUrl = allowedMediaUrl(full?.url);
    if (typeof item?.id !== 'string' || !previewUrl || !fullUrl) return null;
    return {
      id: item.id,
      title: typeof item.title === 'string' ? item.title.slice(0, 120) : '',
      width: Number(preview.width) || 100,
      height: Number(preview.height) || 100,
      preview: previewUrl,
      full: fullUrl,
      size: Number(full.size) || null,
    };
  }).filter(Boolean);
}

export function registerGifs({ app, requireSession, config = gifConfigFromEnv(), fetchImpl = globalThis.fetch, now = () => Date.now() }) {
  const cache = new Map();
  const usage = new Map();

  function overLimit(userId) {
    const minute = Math.floor(now() / 60_000);
    const entry = usage.get(userId);
    if (!entry || entry.minute !== minute) { usage.set(userId, { minute, count: 1 }); return false; }
    entry.count += 1;
    return entry.count > REQUESTS_PER_MINUTE;
  }

  app.get('/api/v1/gifs/status', requireSession, (request, response) => {
    response.json({ enabled: Boolean(config), provider: config ? 'GIPHY' : null });
  });

  app.get('/api/v1/gifs/search', requireSession, async (request, response) => {
    if (!config) return response.status(404).json({ error: 'GIF search is not set up on this server.' });
    if (overLimit(request.session.user_id)) return response.status(429).json({ error: 'Too many GIF searches. Try again in a minute.' });
    const query = typeof request.query.q === 'string' ? request.query.q.trim().slice(0, MAX_QUERY) : '';
    const offset = Math.min(MAX_OFFSET, Math.max(0, Number.parseInt(String(request.query.offset ?? '0'), 10) || 0));
    const key = `${query.toLowerCase()}|${offset}`;
    const cached = cache.get(key);
    if (cached && now() - cached.at < CACHE_MS) return response.json(cached.value);
    const url = new URL(query ? SEARCH_URL : TRENDING_URL);
    url.searchParams.set('api_key', config.apiKey);
    if (query) url.searchParams.set('q', query);
    url.searchParams.set('limit', String(GIF_PAGE_SIZE));
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('rating', config.rating);
    url.searchParams.set('bundle', 'messaging_non_clips');
    try {
      const upstream = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
      if (!upstream.ok) return response.status(502).json({ error: 'GIF search is unavailable right now.' });
      const body = await upstream.json();
      const value = { gifs: presentGifs(body), next: offset + GIF_PAGE_SIZE <= MAX_OFFSET ? offset + GIF_PAGE_SIZE : null, attribution: 'Powered by GIPHY' };
      if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), value });
      return response.json(value);
    } catch {
      return response.status(502).json({ error: 'GIF search is unavailable right now.' });
    }
  });

  // The GIF bytes, fetched here so the phone never connects to GIPHY. GIPHY hosts only, size-capped.
  app.get('/api/v1/gifs/media', requireSession, async (request, response) => {
    if (!config) return response.status(404).json({ error: 'GIF search is not set up on this server.' });
    const target = allowedMediaUrl(request.query.u);
    if (!target) return response.status(400).json({ error: 'Only GIPHY images can be loaded here.' });
    try {
      const upstream = await fetchImpl(target, { redirect: 'error', signal: AbortSignal.timeout(15000) });
      const type = String(upstream.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!upstream.ok || !MEDIA_TYPES.has(type)) return response.status(502).json({ error: 'That GIF could not be loaded.' });
      const declared = Number(upstream.headers.get('content-length') ?? 0);
      if (declared > MAX_GIF_BYTES) return response.status(413).json({ error: 'That GIF is too large.' });
      const bytes = Buffer.from(await upstream.arrayBuffer());
      if (bytes.length > MAX_GIF_BYTES) return response.status(413).json({ error: 'That GIF is too large.' });
      response.set({ 'Content-Type': type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      return response.send(bytes);
    } catch {
      return response.status(502).json({ error: 'That GIF could not be loaded.' });
    }
  });
}
