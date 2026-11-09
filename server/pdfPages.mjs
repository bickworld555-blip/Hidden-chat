// Page count of a PDF, for WhatsApp's "1 page • 0.94 MB • PDF" under a document. Read from the page tree's
// /Count (the largest one is the root's); newer PDFs keep those objects in compressed object streams, which are
// inflated and searched too. Unknown (null) when the file is not a readable PDF or is too large to inspect.
import { open } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';

const MAX_INSPECT_BYTES = 64 * 1024 * 1024;
const PAGES_COUNT = /\/Type\s*\/Pages\b[^]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^]*?\/Type\s*\/Pages\b/g;

function largestCount(text) {
  let best = 0;
  // Each match is scoped to one dictionary at most: cut the text at "endobj" so /Count never pairs across objects.
  for (const object of text.split('endobj')) {
    for (const match of object.matchAll(PAGES_COUNT)) best = Math.max(best, Number(match[1] ?? match[2]));
  }
  return best;
}

export function pdfPageCount(bytes) {
  if (!bytes || bytes.length < 8 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return null;
  const text = bytes.toString('latin1');
  let pages = largestCount(text);
  if (!pages) {
    // Compressed object streams (PDF 1.5+): inflate each Flate stream and look inside.
    const streams = /stream\r?\n/g;
    for (let match; (match = streams.exec(text)) && !pages;) {
      const start = match.index + match[0].length;
      const end = text.indexOf('endstream', start);
      if (end < 0) break;
      try {
        pages = Math.max(pages, largestCount(inflateSync(bytes.subarray(start, end)).toString('latin1')));
      } catch {
        // Not a Flate stream (an image, a font…).
      }
      streams.lastIndex = end;
    }
  }
  return pages > 0 ? pages : null;
}

const cache = new Map();

// Page count of a stored file, remembered per file (stored files never change).
export async function pdfPageCountOfFile(path) {
  if (cache.has(path)) return cache.get(path);
  let pages = null;
  let handle;
  try {
    handle = await open(path, 'r');
    const { size } = await handle.stat();
    if (size <= MAX_INSPECT_BYTES) {
      const bytes = Buffer.alloc(size);
      await handle.read(bytes, 0, size, 0);
      pages = pdfPageCount(bytes);
    }
  } catch {
    pages = null;
  } finally {
    await handle?.close();
  }
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  cache.set(path, pages);
  return pages;
}
