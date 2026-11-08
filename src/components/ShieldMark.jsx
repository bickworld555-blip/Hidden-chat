import { useId } from 'react';

export default function ShieldMark({ className = '' }) {
  const id = useId();
  return (
    <svg className={className} viewBox="0 0 100 112" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e9fff4" /><stop offset=".23" stopColor="#526f64" />
          <stop offset=".48" stopColor="#effff6" /><stop offset=".7" stopColor="#405c52" />
          <stop offset="1" stopColor="#b6e0cb" />
        </linearGradient>
        <linearGradient id={`${id}-green`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#318a64" /><stop offset="1" stopColor="#071e18" />
        </linearGradient>
      </defs>
      <path d="M50 4 91 19v41c0 23-15 35-41 48C24 95 9 83 9 60V19Z" fill="#061a15" stroke={`url(#${id}-metal)`} strokeWidth="5" />
      <path d="M50 12 83 24v36c0 18-12 29-33 40C29 89 17 78 17 60V24Z" fill={`url(#${id}-green)`} stroke="#8ab7a0" strokeWidth="2" />
      <path d="M25 29 50 53 75 29v39L62 78V53L50 64 38 53v25L25 68Z" fill={`url(#${id}-metal)`} stroke="#112c23" strokeWidth="3" strokeLinejoin="round" />
      <path d="M36 17 50 12l14 5-3 15-11 12-11-12Z" fill="#3ba77c" stroke="#d3f5e1" strokeWidth="2" />
    </svg>
  );
}
