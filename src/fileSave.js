// Saves a file made on this device (a backup, a chat export): Download/Hidden Messenger in the Android app,
// the browser's download otherwise. Resolves { path } when the app saved it, { downloaded: true } in a browser.
import { nativeSaveBytes, nativeShell } from './native.js';

export async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export const safeFilename = (name, fallback = 'file') => (String(name ?? '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120) || fallback);

export async function saveFile(blob, filename, mimeType = blob.type || 'application/octet-stream') {
  const name = safeFilename(filename);
  if (nativeShell()) {
    const saved = await nativeSaveBytes({ data: await blobToBase64(blob), filename: name, mimeType });
    if (saved) return { path: saved.path };
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return { downloaded: true };
}
