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
