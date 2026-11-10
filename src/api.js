export function normalizeApiBaseUrl(value = '') {
  if (typeof value !== 'string') throw new TypeError('VITE_API_BASE_URL must be a string.');
  if (!value.trim()) return '';
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('VITE_API_BASE_URL must be an HTTP(S) origin without credentials, paths, query or fragment.');
  }
  return url.origin;
}

const apiBaseUrl = normalizeApiBaseUrl(import.meta.env?.VITE_API_BASE_URL);

/** The public web origin for links people share (invites): the server the app talks to, else this page. */
export function publicOrigin(baseUrl = apiBaseUrl, page = globalThis.location) {
  return normalizeApiBaseUrl(baseUrl) || page?.origin || 'https://hiddenmessenger.com';
}

export function apiUrl(path, baseUrl = apiBaseUrl) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    throw new TypeError('API path must start with /api/.');
  }
  const base = normalizeApiBaseUrl(baseUrl);
  return base ? new URL(path, base).href : path;
}

export function websocketUrl(baseUrl = apiBaseUrl, pageUrl = globalThis.location?.href) {
  const url = new URL('/ws', normalizeApiBaseUrl(baseUrl) || pageUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('WebSocket requires an HTTP(S) app origin.');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

export function apiFetch(path, options = {}) {
  const url = apiUrl(path);
  const target = url.startsWith('/') ? globalThis.location : new URL(url);
  if (target?.protocol === 'https:' && target.hostname.endsWith('.ngrok-free.app')) {
    const headers = new Headers(options.headers);
    headers.set('ngrok-skip-browser-warning', 'true');
    return globalThis.fetch(url, { ...options, headers });
  }
  return globalThis.fetch(url, options);
}
