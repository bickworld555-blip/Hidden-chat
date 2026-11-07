// Owns how uploaded files are named, typed, and described on download, so every format round-trips unchanged.
import { MAX_TRANSFER_BYTES, UPLOAD_CHUNK_BYTES } from '../src/transfer.js';

export const MAX_MEDIA_BYTES = MAX_TRANSFER_BYTES;
// Single-request uploads (voice notes, small files); anything larger goes through resumable chunks.
export const SINGLE_REQUEST_MEDIA_BYTES = UPLOAD_CHUNK_BYTES;
export const MAX_FILENAME_CHARS = 120;
export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

// Used only when the uploader did not supply a specific type (browsers report '' for many formats, e.g. .apk).
const CONTENT_TYPES_BY_EXTENSION = new Map(Object.entries({
  apk: 'application/vnd.android.package-archive',
  aab: 'application/octet-stream',
  ipa: 'application/octet-stream',
  exe: 'application/vnd.microsoft.portable-executable',
  msi: 'application/x-msi',
  dmg: 'application/x-apple-diskimage',
  deb: 'application/vnd.debian.binary-package',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  zip: 'application/zip',
  rar: 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  bz2: 'application/x-bzip2',
  xz: 'application/x-xz',
  epub: 'application/epub+zip',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
}));

// RFC 9110 token characters for the type and subtype of a media type.
const MEDIA_TYPE_PATTERN = /^([!#$%&'*+.^_`|~0-9a-z-]+)\/([!#$%&'*+.^_`|~0-9a-z-]+)$/;

// Types a browser can display without executing script, so they may be served inline.
const INLINE_SAFE_TYPES = new Set(['application/pdf', 'text/plain', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

export function fileExtension(filename) {
  if (typeof filename !== 'string') return '';
  const dot = filename.lastIndexOf('.');
  return dot > 0 && dot < filename.length - 1 ? filename.slice(dot + 1).toLowerCase() : '';
}

// Replaces path separators and control characters, and shortens long names without cutting off the extension.
export function sanitizeFilename(rawName) {
  const cleaned = String(rawName ?? '').replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim();
  const characters = Array.from(cleaned);
  if (characters.length === 0) return 'attachment';
  if (characters.length <= MAX_FILENAME_CHARS) return cleaned;
  const dot = characters.lastIndexOf('.');
  const keepsExtension = dot > 0 && characters.length - dot <= 17;
  const suffix = keepsExtension ? characters.slice(dot) : [];
  const stem = (keepsExtension ? characters.slice(0, dot) : characters).slice(0, MAX_FILENAME_CHARS - suffix.length);
  return `${stem.join('').trimEnd()}${suffix.join('')}`;
}

function parseMediaType(value) {
  const essence = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return MEDIA_TYPE_PATTERN.test(essence) ? essence : '';
}

// The uploader's declared type wins; generic or missing types fall back to the file extension.
export function resolveContentType(declared, filename) {
  const parsed = parseMediaType(declared);
  if (parsed && parsed !== DEFAULT_CONTENT_TYPE) return parsed;
  return CONTENT_TYPES_BY_EXTENSION.get(fileExtension(filename)) ?? DEFAULT_CONTENT_TYPE;
}

export function isInlineSafe(contentType) {
  const essence = parseMediaType(contentType);
  return INLINE_SAFE_TYPES.has(essence) || essence.startsWith('audio/') || essence.startsWith('video/');
}

// RFC 6266 header with an ASCII fallback and an RFC 8187 UTF-8 name, so the exact original filename survives.
export function contentDisposition(filename, disposition = 'attachment') {
  const fallback = filename.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
