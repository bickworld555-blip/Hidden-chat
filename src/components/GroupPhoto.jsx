import { Users } from 'lucide-react';
import { useAvatarSrc } from '../avatar.js';

// A group's photo (server/parity.mjs, members only, fetched with the session like a profile photo), else the group icon.
export default function GroupPhoto({ image, className, iconSize = 24 }) {
  const src = useAvatarSrc(image ?? '');
  return <span className={`${className} ${src ? 'has-photo' : ''}`} aria-hidden="true">{src ? <img src={src} alt="" /> : <Users size={iconSize} />}</span>;
}
