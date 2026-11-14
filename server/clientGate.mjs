// Apps older than the current wire version (src/clientVersion.js) are refused: they predate end-to-end-only,
// queue-based delivery and would send plaintext or rely on history the server no longer keeps. Requests say their
// version in the X-HM-Client header, the realtime socket in a "relay.client.<n>" subprotocol. Old apps get 426 with
// a pointer to the download page.
export const CURRENT_CLIENT_PROTOCOL = 2;
const HEADER = 'x-hm-client';
const DOWNLOAD = '/download';

// Fetched by the browser itself (an <img> or a one-time download link), which cannot add a header.
const OPEN_PATHS = [
  /^\/(health|ready)$/,
  /^\/users\/[^/]+\/avatar$/,
  // ejabberd's offline-message hook (server/xmpp.mjs): not an app, authenticated by its HMAC signature.
  /^\/xmpp\/offline$/,
];

export function clientProtocolOf(value) {
  const number = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** The minimum this server accepts: RELAY_MIN_CLIENT, else the current version in production and none locally. */
export function minimumClientProtocol(env = process.env, { production = env.NODE_ENV === 'production' || Boolean(env.DATABASE_URL) } = {}) {
  if (env.RELAY_MIN_CLIENT !== undefined && env.RELAY_MIN_CLIENT !== '') return clientProtocolOf(env.RELAY_MIN_CLIENT);
  return production ? CURRENT_CLIENT_PROTOCOL : 0;
}

export function updateRequiredBody(minimum) {
  return { error: 'This version of Hidden Messenger is no longer supported. Update the app to keep chatting.', code: 'update_required', minimum, update: DOWNLOAD };
}

/** Express middleware for /api/v1. */
export function clientGate(minimum) {
  return (request, response, next) => {
    if (!minimum) return next();
    if (OPEN_PATHS.some((pattern) => pattern.test(request.path))) return next();
    if (request.method === 'GET' && /^\/media\/[^/]+$/.test(request.path) && typeof request.query.dl === 'string') return next();
    if (clientProtocolOf(request.get(HEADER)) >= minimum) return next();
    response.status(426).json(updateRequiredBody(minimum));
  };
}

/** For the realtime socket: the offered subprotocols must include relay.client.<n> with n ≥ minimum. */
export function socketClientAllowed(offered, minimum) {
  if (!minimum) return true;
  return offered.some((protocol) => protocol.startsWith('relay.client.') && clientProtocolOf(protocol.slice('relay.client.'.length)) >= minimum);
}

// --- Web and desktop companions sign in only by linking with the phone (QR code), like WhatsApp Web. ---
// A browser (the website, or the desktop app that loads it) always sends an Origin header; the Android app sends its
// bundled origin. Password sign-in and new accounts are refused for any other origin. Scripts and tests without an
// Origin header are not browsers and keep the API. On in production; RELAY_WEB_PASSWORD_SIGNIN=1 turns it off (e.g.
// a developer's browser), =0 turns it on elsewhere.
export function webPasswordSignInAllowed(env = process.env, { production = env.NODE_ENV === 'production' || Boolean(env.DATABASE_URL) } = {}) {
  if (env.RELAY_WEB_PASSWORD_SIGNIN === '1') return true;
  if (env.RELAY_WEB_PASSWORD_SIGNIN === '0') return false;
  return !production;
}

export const LINK_WITH_PHONE_BODY = Object.freeze({
  error: 'On a computer, Hidden Messenger opens by linking with your phone. In the app on your phone, go to Settings › Linked devices › Link a device and scan the QR code.',
  code: 'link_with_phone',
});

/** Express middleware for the password sign-in and sign-up routes. */
export function phoneOnlySignIn({ allowed, appOrigin }) {
  return (request, response, next) => {
    const origin = request.get('origin');
    if (allowed || !origin || origin === appOrigin) return next();
    return response.status(403).json(LINK_WITH_PHONE_BODY);
  };
}
