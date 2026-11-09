// Web links inside message text: found once here, rendered as tappable links (they open in YouTube, Facebook or the
// browser), and used to describe what another app shared to Hidden Messenger.
const LINK = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
// Punctuation that usually ends the sentence rather than the link ("see https://x.com/a.").
const TRAILING = /[.,;:!?)\]}'"]+$/;

export function linkHref(text) {
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

// Splits text into plain parts and links: [{ text }, { text, href }, …], in order, losing nothing.
export function splitLinks(text) {
  const value = String(text ?? '');
  const parts = [];
  let last = 0;
  for (const match of value.matchAll(LINK)) {
    let link = match[0];
    const trailing = TRAILING.exec(link)?.[0] ?? '';
    // Keep a closing bracket that belongs to the link, e.g. a Wikipedia "(disambiguation)" path.
    const keepParen = trailing.startsWith(')') && link.slice(0, -trailing.length).includes('(');
    if (trailing && !keepParen) link = link.slice(0, -trailing.length);
    if (!link || /^(?:https?:\/\/|www\.)$/i.test(link)) continue;
    if (match.index > last) parts.push({ text: value.slice(last, match.index) });
    parts.push({ text: link, href: linkHref(link) });
    last = match.index + link.length;
  }
  if (last < value.length) parts.push({ text: value.slice(last) });
  return parts;
}

export function firstLink(text) {
  return splitLinks(text).find((part) => part.href)?.href ?? '';
}
