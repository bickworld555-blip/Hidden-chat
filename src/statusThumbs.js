// The small picture on a status card: one still JPEG about 320 px wide per photo or video, made once and kept in a
// bounded cache. A card used to decode the full photo, or keep a <video> (and a hardware decoder) per video status;
// Android has only a handful of decoders, so a row of video statuses made the Updates tab stutter.

export const THUMB_WIDTH = 320;
const CACHE_LIMIT = 40;
const cache = new Map(); // mediaId → Promise<string | null> (an object URL this module owns)

function remember(mediaId, promise) {
  cache.set(mediaId, promise);
  while (cache.size > CACHE_LIMIT) {
    const [oldest, pending] = cache.entries().next().value;
    cache.delete(oldest);
    pending.then((url) => { if (url) URL.revokeObjectURL(url); }).catch(() => {});
  }
  return promise;
}

const scaled = (width, height) => (width > THUMB_WIDTH
  ? { width: THUMB_WIDTH, height: Math.max(1, Math.round(height * (THUMB_WIDTH / width))) }
  : { width, height });

async function encode(source, width, height) {
  const size = scaled(width, height);
  const canvas = typeof OffscreenCanvas === 'function'
    ? new OffscreenCanvas(size.width, size.height)
    : Object.assign(document.createElement('canvas'), size);
  canvas.getContext('2d').drawImage(source, 0, 0, size.width, size.height);
  return canvas.convertToBlob
    ? canvas.convertToBlob({ type: 'image/jpeg', quality: 0.72 })
    : new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.72));
}

// A photo: decoded by createImageBitmap (off the main thread), its bitmap closed once drawn.
async function photoThumb(blob) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  try {
    return await encode(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close?.();
  }
}

// A video: its frame at 0.1 s, then the element lets go of its decoder and its object URL at once.
export function videoFrame(blob, { timeoutMs = 8000, at = 0.1 } = {}) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(blob);
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(null, new Error('timeout')), timeoutMs);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadedmetadata = () => { video.currentTime = Math.min(at, (video.duration || at) / 2); };
    video.onseeked = () => encode(video, video.videoWidth, video.videoHeight).then((frame) => finish(frame), (error) => finish(null, error));
    video.onerror = () => finish(null, new Error('unreadable'));
    video.src = url;
  });
}

/**
 * The card picture for a status's media, as an object URL (null when it can't be made). `loadBlob()` fetches and
 * decrypts the media; it runs once per mediaId while the picture stays cached.
 */
export function statusThumbnail(mediaId, kind, loadBlob) {
  if (!mediaId) return Promise.resolve(null);
  if (cache.has(mediaId)) {
    // Most recently used goes to the end, so the oldest unused picture is the one dropped.
    const hit = cache.get(mediaId);
    cache.delete(mediaId);
    cache.set(mediaId, hit);
    return hit;
  }
  const made = (async () => {
    const blob = await loadBlob();
    const still = kind === 'video' ? await videoFrame(blob) : await photoThumb(blob).catch(() => blob);
    return still ? URL.createObjectURL(still) : null;
  })();
  // A failure is not cached: the next refresh tries again.
  made.catch(() => cache.delete(mediaId));
  return remember(mediaId, made);
}
