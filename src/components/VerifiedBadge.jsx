// The verified badge: a green circle with a white tick, next to verified businesses and channels (chat list, chat
// header, contacts, contact info, profile). Its green comes from --hm-verified, tuned per theme in src/styles.css so it
// stands out at 3:1 or more on both the light and the dark backgrounds it sits on.
export default function VerifiedBadge({ size = 16, className = '' }) {
  return (
    <svg className={`verified-badge ${className}`} width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Verified">
      <title>Verified</title>
      <circle cx="12" cy="12" r="11" style={{ fill: 'var(--hm-verified, #0F9D4E)' }} />
      <path d="M7.2 12.4l3.1 3.1 6.5-6.7" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
