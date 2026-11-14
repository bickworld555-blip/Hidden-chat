// A tiny preview of a photo or video (as WhatsApp sends with every photo): a JPEG of at most THUMB_EDGE pixels, about
// 1–2 KB, made on the sender's phone and carried inside the end-to-end encrypted message (src/e2e/client.js, "th").
// The receiver shows it blurred, at the photo's shape, at once, before the full file is downloaded.
export const THUMB_EDGE = 48;
export const THUMB_MAX_CHARS = 4000;
export const THUMB_PATTERN = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

/** The thumbnail if it is one we accept (a small base64 JPEG), else ''. */
export const cleanThumb = (value) => (typeof value === 'string' && value.length <= THUMB_MAX_CHARS && THUMB_PATTERN.test(value) ? value : '');

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

function videoFrame(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (value) => { URL.revokeObjectURL(url); resolve(value); };
    const timer = setTimeout(() => done(''), 4000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadeddata = () => { video.currentTime = Math.min(0.2, (video.duration || 1) / 2); };
    video.onseeked = () => { clearTimeout(timer); done(video.videoWidth ? draw(video, video.videoWidth, video.videoHeight) : ''); };
    video.onerror = () => { clearTimeout(timer); done(''); };
    video.src = url;
  });
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
