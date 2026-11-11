// Hidden Messenger's verified badge: a rounded shield with a check, in a bright sky-to-royal blue with a soft
// highlight, so it reads clearly on light and navy backgrounds. Shown next to verified businesses and channels.
import { useId } from 'react';

export default function VerifiedBadge({ size = 16, className = '' }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg className={`verified-badge ${className}`} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Verified">
      <title>Verified</title>
      <defs>
        <linearGradient id={`vb-fill-${id}`} x1="4" y1="2" x2="19" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7cc4ff" />
          <stop offset=".55" stopColor="#3b8cf6" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
        <linearGradient id={`vb-shine-${id}`} x1="12" y1="2" x2="12" y2="12" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".55" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* Rounded shield: soft shoulders and a smooth point. */}
      <path d="M12 1.9c.35 0 .7.07 1.03.2l6.1 2.43c.84.34 1.39 1.15 1.39 2.06v4.36c0 5.02-3.3 9.25-7.9 10.84a1.9 1.9 0 0 1-1.24 0C6.78 20.2 3.48 15.97 3.48 10.95V6.6c0-.91.55-1.72 1.39-2.06l6.1-2.44c.33-.13.68-.2 1.03-.2Z" fill={`url(#vb-fill-${id})`} />
      <path d="M12 3.1c.2 0 .4.04.59.11l5.9 2.36c.4.16.66.55.66.98V9.9c-1.9.95-4.33 1.5-7.15 1.5s-5.25-.55-7.15-1.5V6.55c0-.43.26-.82.66-.98l5.9-2.36c.19-.07.39-.11.59-.11Z" fill={`url(#vb-shine-${id})`} />
      <path d="m8.3 12.15 2.55 2.5 4.9-5.05" fill="none" stroke="#fff" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
