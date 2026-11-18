// Share text through the system share sheet. Android's WebView has no navigator.share, so the app uses its own
// (HiddenNativePlugin.shareText); browsers use the Web Share API; anything else copies the text instead.
import { nativeShareText } from './native.js';

/**
 * Resolves 'shared' (a share sheet opened), 'cancelled' (the person closed the browser's sheet) or 'copied' (no share
 * sheet here: the text is on the clipboard for the caller to say so). Rejects only when copying fails as well.
 * A link goes at the end of the text: many apps (WhatsApp among them) drop a separate URL field.
 */
export async function shareText({ text = '', url = '', title = '' } = {}, { nav = globalThis.navigator, native = nativeShareText } = {}) {
  const body = url && !text.includes(url) ? [text, url].filter(Boolean).join('\n') : text;
  if (!body) throw new Error('Nothing to share.');
  if (await native(body, title)) return 'shared';
  if (typeof nav?.share === 'function') {
    try {
      await nav.share({ ...(title ? { title } : {}), text: body });
      return 'shared';
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
      // NotAllowedError and the like: fall through to copying.
    }
  }
  await nav.clipboard.writeText(body);
  return 'copied';
}
