// Settings › Storage and data › Media upload quality, for videos (WhatsApp: one setting for photos and videos).
// Standard: in the Android app a video over STANDARD_VIDEO.minBytes is re-encoded on the phone (H.264, at most 720p
// on its short side, ~2 Mbit/s; HiddenNativePlugin.compressVideo) before it is encrypted and uploaded. HD sends the
// original. In a browser videos are always sent as they are (no encoder there).
import { nativeShell } from './native.js';

export const STANDARD_VIDEO = Object.freeze({ shortSide: 720, bitrate: 2_000_000, minBytes: 6 * 1024 * 1024 });
const WRITE_PIECE_BYTES = 3 * 1024 * 1024;

/** Whether a video should be re-encoded before sending (Standard quality, big enough to be worth it). */
export function needsVideoCompression({ type, size, quality, native = nativeShell() }) {
  return Boolean(native) && quality === 'standard' && /^video\//.test(String(type ?? '')) && Number(size) > STANDARD_VIDEO.minBytes;
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/**
 * The video to send: the phone's re-encoded copy when it is smaller, else the original. Never throws: a phone that
 * can't re-encode this file sends it as it is.
 */
export async function compressVideoForUpload(file, filename) {
  const [{ Filesystem, Directory }, { registerPlugin }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/core')]);
  const plugin = registerPlugin('HiddenNative');
  const path = `upload/${crypto.randomUUID()}.mp4`;
  let output = '';
  let copied = false;
  try {
    // A video picked in the chooser is compressed straight from the phone's own copy (PickedFiles.java): nothing
    // crosses the bridge as base64 first. Only a file the phone does not know (shared in, recorded here) is copied.
    let result = null;
    try {
      result = await plugin.compressPickedVideo({ name: file.name, size: file.size, shortSide: STANDARD_VIDEO.shortSide, bitrate: STANDARD_VIDEO.bitrate });
    } catch { /* not picked here, or the encoder could not read it: copy below */ }
    if (result) {
      output = result.path;
      return await readCompressed(Filesystem, Directory, result, file, filename);
    }
    copied = true;
    for (let offset = 0; offset < file.size; offset += WRITE_PIECE_BYTES) {
      const data = await toBase64(file.slice(offset, offset + WRITE_PIECE_BYTES));
      if (offset === 0) await Filesystem.writeFile({ path, data, directory: Directory.Cache, recursive: true });
      else await Filesystem.appendFile({ path, data, directory: Directory.Cache });
    }
    result = await plugin.compressVideo({ path, shortSide: STANDARD_VIDEO.shortSide, bitrate: STANDARD_VIDEO.bitrate });
    output = result.path;
    return await readCompressed(Filesystem, Directory, result, file, filename);
  } catch {
    return { blob: file, filename };
  } finally {
    if (copied) await Filesystem.deleteFile({ path, directory: Directory.Cache }).catch(() => {});
    if (output) await Filesystem.deleteFile({ path: output, directory: Directory.Cache }).catch(() => {});
  }
}

// The compressed copy, read back through the WebView's local file URL (binary, no base64), or the original when the
// copy is not smaller.
async function readCompressed(Filesystem, Directory, result, file, filename) {
  if (!(Number(result.bytes) > 0) || Number(result.bytes) >= file.size) return { blob: file, filename };
  const { uri } = await Filesystem.getUri({ path: result.path, directory: Directory.Cache });
  const response = await fetch(globalThis.Capacitor.convertFileSrc(uri));
  if (!response.ok) return { blob: file, filename };
  const name = String(filename || 'video').replace(/\.[^.]+$/, '') + '.mp4';
  return { blob: new File([await response.blob()], name, { type: 'video/mp4' }), filename: name };
}
