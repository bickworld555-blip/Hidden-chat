// Shared WebRTC policy: ICE server shape, capture constraints, codec order and SDP tuning.
// Pure functions only, so the browser, the server and Node tests read the same rules.

export const DEFAULT_ICE_SERVERS = Object.freeze([
  Object.freeze({ urls: Object.freeze(['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302']) }),
]);

const ICE_SCHEME = /^(stun|stuns|turn|turns):/i;
const TURN_SCHEME = /^turns?:/i;

function iceUrlList(urls) {
  const list = typeof urls === 'string' ? [urls] : Array.isArray(urls) ? urls : [];
  return list.filter((url) => typeof url === 'string' && ICE_SCHEME.test(url.trim())).map((url) => url.trim());
}

// Keeps valid entries, drops repeated URLs, and drops TURN URLs without credentials:
// browsers reject the whole RTCPeerConnection when a TURN URL lacks them.
export function normalizeIceServers(servers) {
  if (!Array.isArray(servers)) return [];
  const seen = new Set();
  const result = [];
  for (const server of servers) {
    if (!server || typeof server !== 'object') continue;
    const hasCredentials = typeof server.username === 'string' && server.username !== ''
      && typeof server.credential === 'string' && server.credential !== '';
    // The same relay with other credentials is another server (per-user credentials before the shared ones).
    const urls = iceUrlList(server.urls).filter((url) => {
      const key = TURN_SCHEME.test(url) ? `${url}
${server.username}` : url;
      if (seen.has(key) || (TURN_SCHEME.test(url) && !hasCredentials)) return false;
      seen.add(key);
      return true;
    });
    if (urls.length === 0) continue;
    const entry = { urls: urls.length === 1 ? urls[0] : urls };
    if (hasCredentials && urls.some((url) => TURN_SCHEME.test(url))) {
      entry.username = server.username;
      entry.credential = server.credential;
    }
    result.push(entry);
  }
  return result;
}

// RELAY_TURN_URL accepts several ports/transports separated by commas or spaces,
// e.g. "turn:host:3478?transport=udp, turn:host:3478?transport=tcp, turns:host:443?transport=tcp".
// Per-user, expiring TURN credentials (the TURN REST API, coturn use-auth-secret): username "<expiry>:<userId>",
// password base64(HMAC-SHA1(secret, username)). Each user has their own allocation quota on the relay; one shared
// username let a few calls use up the whole app's quota, so ICE restarts after a network switch found no relay.
export const TURN_CREDENTIAL_TTL_SECONDS = 24 * 60 * 60;

export function turnServerFromEnv({ url, username, credential } = {}) {
  const urls = String(url ?? '').split(/[\s,]+/).filter(Boolean);
  if (urls.length === 0) return null;
  return { urls, username: username ?? '', credential: credential ?? '' };
}

export function videoConstraints(facing = 'user') {
  return {
    facingMode: facing,
    // 720p at 30 fps, as video calls on phones are made (WhatsApp-class calls run 480p–720p). 1080p made the phone
    // encode 2.25× the pixels and asked a mobile uplink for up to 4 Mbps: the encoder fell behind, the phone heated
    // up and frames froze. WebRTC still lowers the resolution by itself on a weak network.
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 30, max: 30 },
  };
}

export function mediaConstraints(mode, facing = 'user') {
  return {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } },
    video: mode === 'video' ? videoConstraints(facing) : false,
  };
}

export const VIDEO_CODEC_ORDER = Object.freeze(['video/VP8', 'video/H264']);
export const AUDIO_MAX_BITRATE = 48_000;
// Enough for sharp 720p30; a cap, not a target (bandwidth estimation still lowers it on slow links). 4G uplinks
// often give a call 1–2 Mbps, so a higher cap only invites bursts the network then drops (freezes).
export const VIDEO_MAX_BITRATE = 1_500_000;
export const VIDEO_MAX_FRAMERATE = 30;

// Stable reorder: preferred codecs first in the given order; everything else (VP9, AV1, rtx, red,
// ulpfec) keeps its relative order behind them so retransmission and FEC remain negotiable.
export function orderCodecs(codecs, preferred = VIDEO_CODEC_ORDER) {
  if (!Array.isArray(codecs)) return [];
  const rank = (codec) => {
    const index = preferred.findIndex((mime) => mime.toLowerCase() === String(codec?.mimeType).toLowerCase());
    return index < 0 ? preferred.length : index;
  };
  return codecs.map((codec, index) => ({ codec, index }))
    .sort((left, right) => rank(left.codec) - rank(right.codec) || left.index - right.index)
    .map(({ codec }) => codec);
}

// Redundant audio (RFC 2198 "red"): each packet also carries the previous Opus frame, so a lost packet is rebuilt
// from the next one and voice does not stutter on a lossy network. It roughly doubles the audio bitrate (about 32 to
// 64 kb/s), so a call turns it on only while the loss on what it sends stays above AUDIO_RED_LOSS, and off again once
// the loss has stayed under AUDIO_RED_CLEAR_LOSS for AUDIO_RED_CLEAR_SAMPLES samples.
export const AUDIO_RED_LOSS = 0.05;
export const AUDIO_RED_SAMPLES = 2;
export const AUDIO_RED_CLEAR_LOSS = 0.02;
export const AUDIO_RED_CLEAR_SAMPLES = 15;

/** Audio codecs in preference order: red first when `red`, otherwise Opus first (red stays negotiable behind it). */
export function orderAudioCodecs(codecs, red) {
  return orderCodecs(codecs, red ? ['audio/red', 'audio/opus'] : ['audio/opus']);
}

/**
 * Whether a description's (first) audio section prefers red: its first payload type is red/48000. An answer that
 * mirrors this choice makes both directions use redundant audio (the codec each side sends follows the answer).
 */
export function sdpPrefersRed(sdp) {
  if (typeof sdp !== 'string') return false;
  const line = sdp.match(/^m=audio \S+ \S+ (\d+)/m);
  if (!line) return false;
  return new RegExp(`^a=rtpmap:${line[1]} red/48000`, 'im').test(sdp);
}

// fmtp parameters describe what the sender of this SDP wants to receive, so each side
// tunes only the description it sends: in-band FEC hides packet loss, DTX saves bandwidth in silence.
export function tuneOpusSdp(sdp) {
  if (typeof sdp !== 'string') return sdp;
  const opusPayloads = new Set([...sdp.matchAll(/a=rtpmap:(\d+) opus\/48000/gi)].map((match) => match[1]));
  if (opusPayloads.size === 0) return sdp;
  return sdp.replace(/a=fmtp:(\d+) ([^\r\n]*)/g, (line, payload, params) => {
    if (!opusPayloads.has(payload)) return line;
    const values = new Map(params.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const [key, ...rest] = part.split('=');
      return [key, rest.join('=')];
    }));
    values.set('useinbandfec', '1');
    if (!values.has('usedtx')) values.set('usedtx', '1');
    if (!values.has('maxaveragebitrate')) values.set('maxaveragebitrate', String(AUDIO_MAX_BITRATE));
    return `a=fmtp:${payload} ${[...values].map(([key, value]) => `${key}=${value}`).join(';')}`;
  });
}

// Older clients nested the description ({ sdp: { type, sdp } }); read both shapes once here.
export function readDescription(raw) {
  let type = raw?.type;
  let sdp = raw?.sdp;
  for (let depth = 0; sdp && typeof sdp === 'object' && depth < 4; depth += 1) {
    if (typeof sdp.type === 'string') type = sdp.type;
    sdp = sdp.sdp;
  }
  if ((type !== 'offer' && type !== 'answer') || typeof sdp !== 'string' || sdp === '') return null;
  return { type, sdp };
}

export function describeForPeer(description) {
  return { type: description.type, sdp: tuneOpusSdp(description.sdp) };
}

export function candidateToJson(candidate) {
  if (typeof candidate?.toJSON === 'function') return candidate.toJSON();
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment ?? null,
  };
}
