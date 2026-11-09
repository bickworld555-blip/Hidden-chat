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
    const urls = iceUrlList(server.urls).filter((url) => {
      if (seen.has(url) || (TURN_SCHEME.test(url) && !hasCredentials)) return false;
      seen.add(url);
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
export function turnServerFromEnv({ url, username, credential } = {}) {
  const urls = String(url ?? '').split(/[\s,]+/).filter(Boolean);
  if (urls.length === 0) return null;
  return { urls, username: username ?? '', credential: credential ?? '' };
}

export function videoConstraints(facing = 'user') {
  return {
    facingMode: facing,
    // Full HD at 30 fps when the camera and connection allow it; WebRTC scales down by itself on weak networks.
    width: { ideal: 1920, max: 1920 },
    height: { ideal: 1080, max: 1080 },
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
// Enough for sharp 1080p30; a cap, not a target (bandwidth estimation still lowers it on slow links).
export const VIDEO_MAX_BITRATE = 4_000_000;
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
