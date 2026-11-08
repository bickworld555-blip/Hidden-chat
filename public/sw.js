// Hidden Messenger service worker: makes the app installable and lets the shell open offline.
// API, WebSocket, media and model requests always go to the network; only the app shell and
// content-hashed build assets are cached.
const VERSION = 'hm-shell-v3';
const SHELL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll([SHELL, '/manifest.webmanifest'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

function bypass(url, request) {
  return request.method !== 'GET'
    || url.origin !== self.location.origin
    || url.pathname.startsWith('/api/')
    || url.pathname === '/ws'
    || url.pathname.startsWith('/mediapipe/')
    || request.headers.has('range');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (bypass(url, request)) return;

  if (request.mode === 'navigate') {
    // Network first so deploys show immediately; the cached shell is only an offline fallback.
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) (await caches.open(VERSION)).put(SHELL, response.clone());
        return response;
      } catch {
        return (await caches.match(SHELL)) || Response.error();
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    // Vite assets are content-hashed, so a cached copy is always the right one.
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) (await caches.open(VERSION)).put(request, response.clone());
      return response;
    })());
  }
});

// Notification channels (direct_messages, group_messages, reactions) are shown by the page through this
// registration. A click focuses an open window and asks it to open the conversation; with no window open,
// it starts the app at /?open=<chat|group>:<id>.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const open = typeof event.notification.data?.open === 'string' ? event.notification.data.open : '';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find((item) => new URL(item.url).origin === self.location.origin);
    if (client) {
      await client.focus();
      client.postMessage({ type: 'notification:open', open, channel: event.notification.data?.channel });
      return;
    }
    await self.clients.openWindow(open ? `/?open=${encodeURIComponent(open)}` : '/');
  })());
});
