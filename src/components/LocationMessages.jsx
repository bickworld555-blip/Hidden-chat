import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, MapPin, MessageCircle, Navigation, Radio, Square, UserPlus } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { useChatStore } from '../store.js';
import { externalMapUrl, formatDistance, formatRemaining, haversineDistance, isLiveExpired, liveExpiresAt, osmTileUrl, tileFor } from '../geo.js';
import { OSM_ATTRIBUTION } from '../places.js';

// A single OSM tile with the pin drawn at the exact offset: cheap enough for every bubble in a chat.
function StaticMap({ lat, lon, onClick, label }) {
  const tile = tileFor(lat, lon);
  return (
    <button type="button" className="loc-static" onClick={onClick} aria-label={label}>
      <img src={osmTileUrl(tile)} alt="" loading="lazy" style={{ left: `calc(50% - ${tile.offsetX}px)`, top: `calc(50% - ${tile.offsetY}px)` }} />
      <span className="loc-static-pin" aria-hidden="true"><MapPin size={30} /></span>
    </button>
  );
}

export function LocationBubble({ location, onOpen }) {
  return (
    <div className="loc-bubble">
      <StaticMap lat={location.lat} lon={location.lon} onClick={() => onOpen(location)} label={`Open ${location.name || 'location'} on the map`} />
      <div className="loc-bubble-text">
        <strong>{location.name || 'Shared location'}</strong>
        <small>{location.address || `${location.lat.toFixed(5)}, ${location.lon.toFixed(5)}`}{location.accuracy ? ` · ±${formatDistance(location.accuracy)}` : ''}</small>
      </div>
    </div>
  );
}

// Live sharing card: consent prompt for the recipient, live distance while active, final state after.
export function LiveLocationBubble({ live, mine, peerName, send, onOpen }) {
  const session = useChatStore((state) => state.liveSessions[live.sessionId]);
  const acceptLiveSession = useChatStore((state) => state.acceptLiveSession);
  const declineLiveSession = useChatStore((state) => state.declineLiveSession);
  const stopLiveSession = useChatStore((state) => state.stopLiveSession);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (session?.status !== 'active' && session?.status !== 'requested') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [session?.status]);

  const expiresAt = liveExpiresAt(live.startedAt, live.durationMs);
  const expired = expiresAt !== null && now >= expiresAt;
  // Without a session in memory (reload, other device) the card can only say whether the window has passed.
  const status = session ? (session.status === 'active' && expired ? 'ended' : session.status) : expired ? 'ended' : 'unknown';
  const distance = session?.me && session?.peer ? haversineDistance(session.me, session.peer) : null;
  const canAct = Boolean(send);

  return (
    <div className={`loc-bubble live-${status}`}>
      <div className="loc-live-head">
        <span className="loc-live-icon"><Radio size={18} /></span>
        <div className="loc-bubble-text">
          <strong>Live location</strong>
          <small>
            {status === 'requested' && (mine ? `Waiting for ${peerName} to accept` : `${peerName} wants to share live location with you`)}
            {status === 'active' && `Sharing · ends in ${formatRemaining(expiresAt - now)}${distance !== null ? ` · ${formatDistance(distance)} apart` : ''}`}
            {status === 'ended' && (session?.endReason === 'expired' || (expired && !session) ? 'Live location ended' : 'Live location stopped')}
            {status === 'declined' && (mine ? `${peerName} declined` : 'You declined')}
            {status === 'unknown' && 'Live location (this device did not take part)'}
          </small>
        </div>
      </div>
      {live.comment && <p className="loc-live-comment">{live.comment}</p>}
      {status === 'requested' && !mine && canAct && (
        <div className="loc-live-actions">
          <button type="button" className="decline" onClick={() => declineLiveSession(live.sessionId, send)}>Decline</button>
          <button type="button" className="accept" onClick={() => acceptLiveSession(live.sessionId, send)}>Accept</button>
        </div>
      )}
      {status === 'active' && (
        <div className="loc-live-actions">
          <button type="button" className="decline" onClick={() => canAct && stopLiveSession(live.sessionId, send)}><Square size={14} /> Stop sharing</button>
          <button type="button" className="accept" onClick={() => onOpen(live.sessionId)}><Navigation size={14} /> View on map</button>
        </div>
      )}
      {status === 'requested' && mine && (
        <div className="loc-live-actions">
          <button type="button" className="decline" onClick={() => canAct && stopLiveSession(live.sessionId, send)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

export function ContactBubble({ contact, onMessage }) {
  const chats = useChatStore((state) => state.chats);
  const known = chats.some((chat) => chat.id === contact.id);
  return (
    <div className="loc-bubble contact-bubble">
      <div className="contact-bubble-head">
        <Avatar name={contact.name} initials={contact.initials} color={contact.color} image={contact.avatar} />
        <div className="loc-bubble-text">
          <strong>{contact.name}</strong>
          {contact.username && <small>@{contact.username}</small>}
        </div>
      </div>
      {contact.id && (
        <div className="loc-live-actions">
          <button type="button" className="accept" onClick={() => onMessage(contact)}>
            {known ? <MessageCircle size={14} /> : <UserPlus size={14} />} {known ? 'Message' : 'Add and message'}
          </button>
        </div>
      )}
    </div>
  );
}
