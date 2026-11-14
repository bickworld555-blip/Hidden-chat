// Photo quality when sending, like WhatsApp's Standard / HD choice:
//   • standard — the longest side is scaled to at most 1600 px and saved as JPEG (quality 0.8): quick to send;
//   • hd — the original file is sent unchanged (only images larger than 4096 px are scaled to 4096 at 0.92).
// Animated GIFs, SVGs and documents are always sent as they are. Videos: Standard re-encodes big ones on the phone
// (src/videoCompress.js, Android app only); HD sends them as recorded.
import { compressVideoForUpload, needsVideoCompression } from './videoCompress.js';
import { thumbFromSource } from './mediaThumb.js';

export const QUALITY = Object.freeze({
  standard: { maxSide: 1600, quality: 0.8 },
  hd: { maxSide: 4096, quality: 0.92 },
});

export function isResizablePhoto(type) {
  return typeof type === 'string' && /^image\/(jpeg|png|webp|heic|heif|bmp)$/i.test(type);
}

/** Output size for a photo of width × height under a longest-side limit (null = keep as is). */
export function scaledSize(width, height, maxSide) {
  if (!(width > 0 && height > 0)) return null;
  const longest = Math.max(width, height);
  if (longest <= maxSide) return null;
  const ratio = maxSide / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

const replaceExtension = (filename, extension) => {
  const base = (filename || 'photo').replace(/\.[a-z0-9]{1,5}$/i, '');
  return `${base}.${extension}`;
};

/**
 * Prepares a picked file for sending at `quality` ('standard' | 'hd'). Returns { blob, filename, thumb? }; when the
 * photo can't be decoded on this device the original is sent. A photo's micro thumbnail (src/mediaThumb.js) is drawn
 * from the resized picture already in memory, so the sent photo is never decoded a second time.
 */
export async function prepareForSend(file, filename, quality = 'standard') {
  const preset = QUALITY[quality] ?? QUALITY.standard;
  if (needsVideoCompression({ type: file?.type, size: file?.size, quality })) return compressVideoForUpload(file, filename);
  if (!isResizablePhoto(file?.type) || typeof createImageBitmap !== 'function') return { blob: file, filename };
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { blob: file, filename };
  }
  try {
    const size = scaledSize(bitmap.width, bitmap.height, preset.maxSide);
    // HD keeps the original bytes whenever no scaling is needed; Standard re-encodes large JPEG-heavy photos too.
    if (!size && (quality === 'hd' || file.size <= 600 * 1024)) return { blob: file, filename, thumb: thumbFromSource(bitmap, bitmap.width, bitmap.height) };
    const target = size ?? { width: bitmap.width, height: bitmap.height };
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(target.width, target.height) : Object.assign(document.createElement('canvas'), target);
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, target.width, target.height);
    context.drawImage(bitmap, 0, 0, target.width, target.height);
    // The preview is drawn from the resized picture (measured: drawing it from the full-size photo cost more than it saved).
    const thumb = thumbFromSource(canvas, target.width, target.height);
    const blob = canvas.convertToBlob
      ? await canvas.convertToBlob({ type: 'image/jpeg', quality: preset.quality })
      : await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', preset.quality));
    if (!blob || (!size && blob.size >= file.size)) return { blob: file, filename, thumb };
    return { blob: new File([blob], replaceExtension(filename, 'jpg'), { type: 'image/jpeg' }), filename: replaceExtension(filename, 'jpg'), thumb };
  } finally {
    bitmap.close?.();
  }
}
