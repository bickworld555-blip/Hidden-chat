import { registerMediaDescriptor } from './media.js';
import { packDescriptor, unpackDescriptor } from './mediaCrypto.js';
import { cleanVoiceLang } from './voiceLanguage.js';
export function formatClock(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export function waveformPeaks(seed, count = 40) {
  let state = 0;
  for (const char of String(seed)) state = (state * 31 + char.charCodeAt(0)) >>> 0;
  return Array.from({ length: count }, () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return 18 + (state % 82);
  });
}

export function voiceExtension(mimeType) {
  const type = String(mimeType || '');
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mp4')) return 'm4a';
  return 'webm';
}

// The media endpoint stores uploads as octet-stream, so playback needs the type recovered from the filename.
export function voiceMimeFromDisposition(disposition) {
  const extension = /\.([a-z0-9]+)(?:["';\s]|$)/i.exec(String(disposition || ''))?.[1]?.toLowerCase();
  if (extension === 'ogg') return 'audio/ogg';
  if (extension === 'm4a') return 'audio/mp4';
  return 'audio/webm';
}

// "voice:<mediaId>:<seconds>" or, sent as view once, "voice:<mediaId>:<seconds>:once"; after the recipient
// plays a view once note the server rewrites it to "voice-opened:<seconds>" and deletes the audio.
// An end-to-end encrypted note adds its file key: "voice:<mediaId>:<seconds>:<once or empty>:<key>" (the key is
// src/mediaCrypto.js's descriptor; the whole message travels encrypted, src/e2e/) and the language it is spoken in:
// "voice:<mediaId>:<seconds>:<once or empty>:<key>:<lang>" (src/voiceLanguage.js). The server's routing part
// (src/e2e/envelope.js routingFor) keeps only the id and never the key or the language.
export function voiceContent(id, seconds, { viewOnce = false, descriptor = null, lang = '' } = {}) {
  const base = `voice:${id}:${seconds}`;
  if (!descriptor) return viewOnce ? `${base}:once` : base;
  const spoken = cleanVoiceLang(lang);
  return `${base}:${viewOnce ? 'once' : ''}:${packDescriptor(descriptor)}${spoken ? `:${spoken}` : ''}`;
}

export function parseVoiceContent(content) {
  if (typeof content !== 'string') return null;
  if (content.startsWith('voice-opened:')) {
    return { id: null, seconds: Number(content.slice(13)) || 0, viewOnce: true, opened: true };
  }
  if (!content.startsWith('voice:')) return null;
  const [, id, seconds, flag, key, spoken] = content.split(':');
  if (!id) return null;
  const descriptor = key ? unpackDescriptor(key) : null;
  // Every player (VoiceMessage, transcripts, view once) loads through media.js, which decrypts with this key.
  if (descriptor) registerMediaDescriptor(id, descriptor);
  const lang = cleanVoiceLang(spoken);
  return { id, seconds: Number(seconds) || 0, viewOnce: flag === 'once', opened: false, ...(descriptor ? { descriptor } : {}), ...(lang ? { lang } : {}) };
}
