// The media kind for the native bubble (sticker|viewonce|voice|photo|video|gif|audio|doc) or '' — mirrors the native
// MessagePreview.kindOf (android …/MessagePreview.java) so both delivery paths classify media the same way. Owned here
// (pure, no deps) so the native projection in App.jsx and the Node test share one classifier.
//
// Phase 5: stickers and view-once carry their raw ref (not just the chat-list preview label) so the native bubble can
// render them — a sticker's emoji, a view-once "Tap to view" / "opened" placeholder. The native projection only sets
// mediaSource when this returns a truthy kind, so a non-'' result here is the precondition for the raw ref to reach the
// native store.
export function nativeMediaKind(content) {
  if (typeof content !== 'string') return '';
  if (content.startsWith('sticker:')) return 'sticker';
  if (content.startsWith('viewonce:')) return 'viewonce';
  if (content.startsWith('voice:') || content.startsWith('voice-opened:')) return 'voice';
  if (content.startsWith('media:') || content.startsWith('emedia:')) {
    let filename = '';
    if (content.startsWith('emedia:')) filename = content.split(':').slice(3).join(':');
    else { const i = content.indexOf(':', 6); filename = i < 0 ? '' : content.slice(i + 1); }
    const dot = filename.lastIndexOf('.');
    const ext = dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
    if (ext === 'gif') return 'gif';
    if (['jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif', 'heic', 'heif', 'svg', 'tif', 'tiff'].includes(ext)) return 'photo';
    if (['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp'].includes(ext)) return 'video';
    if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba'].includes(ext)) return 'audio';
    return 'doc';
  }
  return '';
}
