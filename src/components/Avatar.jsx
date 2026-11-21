import { useAvatarSrc } from '../avatar.js';

// Sizes that show a photo larger than a list row use the full upload; the rest a small copy (src/avatar.js).
const FULL_SIZE = new Set(['large', 'xl']);

// `image` and `avatar` are the same thing; contacts arrive from the server with `avatar`.
export default function Avatar({ name, initials, color = 'blue', image, avatar, size = 'normal', online = false }) {
  const src = useAvatarSrc(image ?? avatar ?? '', { thumb: !FULL_SIZE.has(size) });
  return (
    <span className={`avatar avatar-${color} avatar-${size}`} aria-label={name}>
      {src ? <img src={src} alt="" decoding="async" /> : <span>{initials}</span>}
      {online && <i className="presence-dot" />}
    </span>
  );
}
