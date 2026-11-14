// A tiny preview of a photo or video (as WhatsApp sends with every photo): a JPEG of at most THUMB_EDGE pixels, about
// 1–2 KB, made on the sender's phone and carried inside the end-to-end encrypted message (src/e2e/client.js, "th").
// The receiver shows it blurred, at the photo's shape, at once, before the full file is downloaded.
export const THUMB_EDGE = 48;
export const THUMB_MAX_CHARS = 4000;
export const THUMB_PATTERN = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

/** The thumbnail if it is one we accept (a small base64 JPEG), else ''. */
export const cleanThumb = (value) => (typeof value === 'string' && value.length <= THUMB_MAX_CHARS && THUMB_PATTERN.test(value) ? value : '');

/** The micro thumbnail of an already decoded image or video frame (no second decode). */
export function thumbFromSource(source, width, height) {
  try { return cleanThumb(draw(source, width, height)); } catch { return ''; }
}

function draw(source, width, height) {
  const scale = Math.min(1, THUMB_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.6, 0.4, 0.25]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= THUMB_MAX_CHARS) return url;
  }
  return '';
}

// A video's poster (as WhatsApp shows on a video bubble before it is played or even downloaded): a sharp frame of at
// most POSTER_EDGE pixels, ~10–20 KB, carried inside the end-to-end encrypted message ("pv") with its length ("du").
export const POSTER_EDGE = 320;
export const POSTER_MAX_CHARS = 32000;
export const MAX_VIDEO_SECONDS = 24 * 3600;

/** The poster if it is one we accept (a base64 JPEG within POSTER_MAX_CHARS), else ''. */
export const cleanPoster = (value) => (typeof value === 'string' && value.length <= POSTER_MAX_CHARS && THUMB_PATTERN.test(value) ? value : '');
/** A video length in whole seconds (1 … MAX_VIDEO_SECONDS), else 0. */
export const cleanDuration = (value) => (Number.isInteger(value) && value > 0 && value <= MAX_VIDEO_SECONDS ? value : 0);

function drawPoster(source, width, height) {
  const scale = Math.min(1, POSTER_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.72, 0.55, 0.4]) {
    const url = canvas.toDataURL('image/jpeg', quality);
    if (url.length <= POSTER_MAX_CHARS) return url;
  }
  return '';
}

/**
 * One decode of a video file: { thumb, poster, seconds, width, height } (empty values when the browser cannot read it).
 * The frame is taken a little in (not the often-black first frame).
 */
export function videoPreview(file) {
  const empty = { thumb: '', poster: '', seconds: 0, width: 0, height: 0 };
  if (typeof document === 'undefined' || !file) return Promise.resolve(empty);
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let finished = false;
    const done = (value) => { if (finished) return; finished = true; clearTimeout(timer); video.removeAttribute('src'); video.load?.(); URL.revokeObjectURL(url); resolve(value); };
    const timer = setTimeout(() => done(empty), 6000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadeddata = () => { video.currentTime = Math.min(0.5, (Number.isFinite(video.duration) ? video.duration : 1) / 3); };
    video.onseeked = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (!width) { done(empty); return; }
      let thumb = '';
      let poster = '';
      try { thumb = cleanThumb(draw(video, width, height)); } catch { /* none */ }
      try { poster = cleanPoster(drawPoster(video, width, height)); } catch { /* none */ }
      done({ thumb, poster, seconds: cleanDuration(Math.round(Number.isFinite(video.duration) ? video.duration : 0)), width, height });
    };
    video.onerror = () => done(empty);
    video.src = url;
  });
}

async function videoFrame(file) {
  return (await videoPreview(file)).thumb;
}

/** The micro thumbnail for a photo or video file, or '' (other files, or when it can't be made). */
export async function makeThumb(file) {
  try {
    if (file?.type?.startsWith('image/')) {
      const bitmap = await createImageBitmap(file);
      const url = draw(bitmap, bitmap.width, bitmap.height);
      bitmap.close?.();
      return cleanThumb(url);
    }
    if (file?.type?.startsWith('video/')) return cleanThumb(await videoFrame(file));
  } catch { /* no preview */ }
  return '';
}
