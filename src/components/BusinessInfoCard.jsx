// A business's profile in its contact info (server: GET /api/v1/users/:id/business): category, description,
// hours with open/closed now, address, email and website. Renders nothing for accounts without a profile.
import { useEffect, useState } from 'react';
import { CalendarClock, Globe, Link2, Mail, MapPin, Store } from 'lucide-react';
import { request } from '../parityApi.js';
import { BusinessCover, hoursSummary, openNow } from './parity/BusinessTools.jsx';

export default function BusinessInfoCard({ userId, sessionToken }) {
  const [business, setBusiness] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!userId || !sessionToken) return undefined;
    request(sessionToken, `/api/v1/users/${encodeURIComponent(userId)}/business`)
      .then((value) => { if (!cancelled) setBusiness(value); })
      .catch(() => { if (!cancelled) setBusiness(null); });
    return () => { cancelled = true; };
  }, [userId, sessionToken]);
  if (!business) return null;
  const { profile, hours } = business;
  const open = openNow(hours);
  return (
    <section className="wa-info-section wa-business-card" aria-label="Business info">
      {profile.cover && <BusinessCover path={profile.cover} token={sessionToken} className="wa-business-cover" />}
      <p className="wa-business-kicker"><Store size={16} aria-hidden="true" /> Business account{profile.category ? ` · ${profile.category}` : ''}</p>
      {profile.description && <p className="wa-business-description">{profile.description}</p>}
      {hours && (
        <p className="wa-business-row"><CalendarClock size={18} aria-hidden="true" />
          <span><strong className={open ? 'is-open' : 'is-closed'}>{open ? 'Open now' : 'Closed now'}</strong><small>{hoursSummary(hours)}</small></span></p>
      )}
      {profile.address && <p className="wa-business-row"><MapPin size={18} aria-hidden="true" /><span>{profile.address}</span></p>}
      {profile.email && <p className="wa-business-row"><Mail size={18} aria-hidden="true" /><a href={`mailto:${profile.email}`}>{profile.email}</a></p>}
      {profile.website && <p className="wa-business-row"><Globe size={18} aria-hidden="true" /><a href={profile.website} target="_blank" rel="noopener noreferrer">{profile.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a></p>}
      {(profile.links ?? []).map((link) => (
        <p key={link.url} className="wa-business-row"><Link2 size={18} aria-hidden="true" /><a href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a></p>
      ))}
    </section>
  );
}
