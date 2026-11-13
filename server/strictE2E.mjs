// Strict end-to-end encryption on the server: what people write must arrive sealed. The app never sends it readable
// (src/e2e/messaging.js holds a message back until it can encrypt it); this refuses a modified or broken client that
// tries, so "the server only sees locked data" is enforced, not only followed. System records (call logs, opened
// view-once markers) are not people's words and stay allowed.
//
// On in production (NODE_ENV=production or DATABASE_URL set); RELAY_STRICT_E2E=1 turns it on elsewhere, =0 off.
import { isEnvelope, isUserContent } from '../src/e2e/envelope.js';

export function strictE2EFromEnv(env = process.env, { production = env.NODE_ENV === 'production' || Boolean(env.DATABASE_URL) } = {}) {
  if (env.RELAY_STRICT_E2E === '1') return true;
  if (env.RELAY_STRICT_E2E === '0') return false;
  return production;
}

/** Whether a strict server must refuse this content: something a person wrote, not end-to-end encrypted. */
export const refusesPlaintext = (strict, content) => Boolean(strict) && typeof content === 'string' && !isEnvelope(content) && isUserContent(content.trim());

export const PLAINTEXT_REFUSED = Object.freeze({
  error: 'Messages must be end-to-end encrypted. Update Hidden Messenger and try again.',
  code: 'e2e_required',
});
