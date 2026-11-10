import { useId } from 'react';

export default function ShieldMark({ className = '' }) {
  const id = useId();
  return (
    <svg className={className} viewBox="0 0 100 112" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-metal`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e9f3ff" /><stop offset=".23" stopColor="#525f6f" />
          <stop offset=".48" stopColor="#eff6ff" /><stop offset=".7" stopColor="#404c5c" />
          <stop offset="1" stopColor="#b6c8e0" />
        </linearGradient>
        <linearGradient id={`${id}-green`} x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#31588a" /><stop offset="1" stopColor="#0f243f" />
        </linearGradient>
      </defs>
      <path d="M50 4 91 19v41c0 23-15 35-41 48C24 95 9 83 9 60V19Z" fill="#0e213b" stroke={`url(#${id}-metal)`} strokeWidth="5" />
      <path d="M50 12 83 24v36c0 18-12 29-33 40C29 89 17 78 17 60V24Z" fill={`url(#${id}-green)`} stroke="#8a9eb7" strokeWidth="2" />
      <path d="M25 29 50 53 75 29v39L62 78V53L50 64 38 53v25L25 68Z" fill={`url(#${id}-metal)`} stroke="#111d2c" strokeWidth="3" strokeLinejoin="round" />
      <path d="M36 17 50 12l14 5-3 15-11 12-11-12Z" fill="#3b6aa7" stroke="#d3e2f5" strokeWidth="2" />
    </svg>
  );
}
