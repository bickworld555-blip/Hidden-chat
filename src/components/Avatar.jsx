import { useAvatarSrc } from '../avatar.js';

// `image` and `avatar` are the same thing; contacts arrive from the server with `avatar`.
export default function Avatar({ name, initials, color = 'blue', image, avatar, size = 'normal', online = false }) {
  const src = useAvatarSrc(image ?? avatar ?? '');
  return (
    <span className={`avatar avatar-${color} avatar-${size}`} aria-label={name}>
      {src ? <img src={src} alt="" /> : <span>{initials}</span>}
      {online && <i className="presence-dot" />}
    </span>
  );
}