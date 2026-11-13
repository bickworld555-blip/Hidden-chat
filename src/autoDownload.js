// Settings › Storage and data › Media auto-download (WhatsApp's rules): which attachments are fetched on their own
// when a message arrives, by the kind of connection — mobile data, Wi-Fi or roaming. Voice messages always are.
// Anything else waits for a tap; until then the message stays unacknowledged, so the server keeps it (30 days).
import { appSettings } from './settings.js';
import { nativeNetworkKind } from './native.js';

export const AUTO_DOWNLOAD_KEYS = Object.freeze({
  mobile: 'media.autoDownload.mobile',
  wifi: 'media.autoDownload.wifi',
  roaming: 'media.autoDownload.roaming',
});

/** The auto-download kind of an attachment from its content type: photos, videos, audio or documents. */
export function autoDownloadKind(contentType) {
  const type = String(contentType ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'photos';
  if (type.startsWith('video/')) return 'videos';
  if (type.startsWith('audio/')) return 'audio';
  return 'documents';
}

/**
 * The connection from the browser's Network Information API (Android WebView, Chrome): "wifi", "mobile", "none",
 * or "wifi" when the browser doesn't say (computers).
 */
export function networkFromConnection(connection, online = true) {
  if (!online) return 'none';
  const type = connection?.type;
  if (type === 'cellular') return 'mobile';
  if (type === 'none') return 'none';
  return 'wifi';
}

/** Whether an attachment of this kind downloads on its own on this network, with these rules ({ mobile: [...], … }). */
export function allowsAutoDownload({ kind, network, rules, voice = false }) {
  if (network === 'none') return false;
  if (voice) return true;
  const allowed = rules?.[network === 'roaming' || network === 'mobile' ? network : 'wifi'] ?? [];
  return allowed.includes(kind);
}

export function autoDownloadRules(settings = appSettings()) {
  return Object.fromEntries(Object.entries(AUTO_DOWNLOAD_KEYS).map(([network, key]) => [network, settings.get(key)]));
}

let cached = null;
/** The current connection ("wifi", "mobile", "roaming" or "none"); asked at most every 10 seconds. */
export async function currentNetwork() {
  if (cached && Date.now() - cached.at < 10_000) return cached.kind;
  const native = await nativeNetworkKind();
  const kind = native && native !== 'unknown'
    ? native
    : networkFromConnection(globalThis.navigator?.connection, globalThis.navigator?.onLine !== false);
  cached = { kind, at: Date.now() };
  return kind;
}

export async function mayAutoDownload(contentType, { voice = false } = {}) {
  return allowsAutoDownload({ kind: autoDownloadKind(contentType), network: await currentNetwork(), rules: autoDownloadRules(), voice });
}
