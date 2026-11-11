// Hidden Messenger's verified-business badge: a small shield with a check, in the app's blue-to-navy accent.
// Shown next to the name of accounts an admin has verified (server/verification.mjs).
import { useId } from 'react';

export default function VerifiedBadge({ size = 16, className = '' }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={`verified-badge ${className}`} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Verified business">
      <title>Verified business</title>
      <defs>
        <linearGradient id={`vb-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#1e3a8a" />
        </linearGradient>
      </defs>
      <path d="M12 1.6 20.2 4.7v6.1c0 5.2-3.4 9.8-8.2 11.6C7.2 20.6 3.8 16 3.8 10.8V4.7Z" fill={`url(#vb-${id})`} />
      <path d="m8.2 12.1 2.6 2.6 5-5.2" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
