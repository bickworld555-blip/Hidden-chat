// Security headers for the website and the web app (/, /app, /admin and their files): what a page may load and run
// (Content-Security-Policy, the same policy the Android app's bundled copy has run under since it was bundled,
// scripts/configure-android.mjs), no framing by other sites, no content-type sniffing, and a short referrer. Before,
// these pages were served with HSTS only (verified live 2026-11-22): a script-injection bug would have had the
// session tokens in IndexedDB within reach, and any site could frame the app.
import { appCsp } from '../scripts/configure-android.mjs';

// The website: its own origin for the API and socket ('self' covers https and wss of the same host), never framed,
// its own manifest.
export const WEB_CSP = appCsp({ extra: ["frame-ancestors 'none'", "manifest-src 'self'"] });

// The policy for a page served as `host`: its own socket is named as well (older browsers do not take 'self' to
// cover wss://). One per host name, built once.
const perHost = new Map();
export function cspForHost(host) {
  if (typeof host !== 'string' || !/^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(host)) return WEB_CSP;
  let policy = perHost.get(host);
  if (!policy) {
    policy = appCsp({ own: [`wss://${host}`], extra: ["frame-ancestors 'none'", "manifest-src 'self'"] });
    if (perHost.size < 50) perHost.set(host, policy);
  }
  return policy;
}

/** Every response: no sniffing. Pages and their files (not /api, not the socket): the policy, no framing, short referrer. */
export function securityHeaders() {
  return (request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (!request.path.startsWith('/api/') && request.path !== '/ws') {
      response.setHeader('Content-Security-Policy', cspForHost(request.headers.host));
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    }
    next();
  };
}
