// Link previews are made by the sender and travel inside the end-to-end encrypted message, like WhatsApp: the
// people who receive it never fetch anything (no request to our server, none to the linked site).
//   Android app: the phone fetches the page and its image itself (LinkFetcher.java) — the server is not involved.
//   Browser: pages cannot be read across sites, so the sender asks our server (only the sender's request; the
//   preview then has no thumbnail, so recipients never load an image from the linked site either).
import { nativeFetchImage, nativeFetchPage, nativeShell } from './native.js';
import { linkProvider, previewFromHtml, previewFromOembed, sanitizePreview, youtubeOembedUrl } from './linkPreviewParse.js';
import { loadLinkPreview } from './components/LinkPreview.jsx';

export const PREVIEW_TIMEOUT_MS = 4000;
const THUMBNAIL_PX = 160;

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

/** A small JPEG data URL (≤ THUMBNAIL_PX on its long side) from base64 image bytes, or '' when it cannot be made. */
export async function thumbnailFrom(base64, contentType) {
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: contentType || 'image/jpeg' }));
    const scale = Math.min(1, THUMBNAIL_PX / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    for (const quality of [0.72, 0.55, 0.4]) {
      const url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= 24_000) return url;
    }
  } catch { /* no thumbnail */ }
  return '';
}

async function onPhone(href) {
  let preview = null;
  if (linkProvider(href) === 'youtube') {
    const page = await nativeFetchPage(youtubeOembedUrl(href));
    if (page?.html) {
      try { preview = previewFromOembed(href, JSON.parse(page.html)); } catch { preview = null; }
    }
  } else {
    const page = await nativeFetchPage(href);
    if (page?.html && /html/i.test(page.contentType ?? '')) preview = previewFromHtml(href, page.url, page.html);
  }
  if (!preview) return null;
  const image = preview.image ? await nativeFetchImage(preview.image) : null;
  const thumbnail = image?.data ? await thumbnailFrom(image.data, image.contentType) : '';
  return { ...preview, thumbnail };
}

async function inBrowser(href, sessionToken) {
  const preview = await loadLinkPreview(href, sessionToken);
  return preview ? { ...preview, thumbnail: '' } : null;
}

/** The preview for a link the user is sending (sanitized for the message), or null after PREVIEW_TIMEOUT_MS. */
export async function buildLinkPreview(href, sessionToken) {
  const made = await withTimeout((nativeShell() ? onPhone(href) : inBrowser(href, sessionToken)).catch(() => null), PREVIEW_TIMEOUT_MS);
  return made ? sanitizePreview(made) : null;
}
