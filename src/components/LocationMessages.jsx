import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { ArrowLeft, ExternalLink, MapPin, MessageCircle, Navigation, Radio, Square, UserPlus } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { useChatStore } from '../store.js';
import { meIcon, peerIcon, useLeafletMap } from './LocationPicker.jsx';
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

// Full-screen map for a shared spot or a live session (both people, a line between them, distance).
export function MapView({ location, sessionId, peer, send, onClose }) {
  const containerRef = useRef(null);
  const session = useChatStore((state) => (sessionId ? state.liveSessions[sessionId] : null));
  const stopLiveSession = useChatStore((state) => state.stopLiveSession);
  const [now, setNow] = useState(() => Date.now());
  const mapRef = useLeafletMap(containerRef, { center: location ? [location.lat, location.lon] : null, zoom: 16 });
  const layersRef = useRef({});

  useEffect(() => {
    if (!sessionId) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, [sessionId]);

  const points = useMemo(() => ({
    me: session?.me ?? null,
    peer: session?.peer ?? (location ? { lat: location.lat, lon: location.lon } : null),
  }), [session?.me, session?.peer, location]);

  // Redraw markers and the connecting line whenever a position changes; fit both when they first appear.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const layers = layersRef.current;
    const place = (key, latLng, factory) => {
      if (!latLng) { layers[key]?.remove(); delete layers[key]; return; }
      if (layers[key]) layers[key].setLatLng(latLng);
      else layers[key] = factory(latLng).addTo(map);
    };
    place('peer', points.peer ? [points.peer.lat, points.peer.lon] : null, (latLng) => L.marker(latLng, { icon: location ? L.divIcon({ className: 'map-pin', html: '<span></span>', iconSize: [20, 20], iconAnchor: [10, 20] }) : peerIcon(peer?.initials ?? peer?.name?.slice(0, 2).toUpperCase()) }));
    place('me', points.me ? [points.me.lat, points.me.lon] : null, (latLng) => L.marker(latLng, { icon: meIcon(), interactive: false }));
    if (points.me && points.peer) {
      const line = [[points.me.lat, points.me.lon], [points.peer.lat, points.peer.lon]];
      if (layers.line) layers.line.setLatLngs(line);
      else {
        layers.line = L.polyline(line, { color: '#00a884', weight: 3, dashArray: '6 6' }).addTo(map);
        map.fitBounds(L.latLngBounds(line), { padding: [60, 60], maxZoom: 17 });
      }
    } else if (points.peer && !layers.line && !location) {
      map.setView([points.peer.lat, points.peer.lon], 16);
    }
  }, [mapRef, points, location, peer]);

  const distance = points.me && points.peer && sessionId ? haversineDistance(points.me, points.peer) : null;
  const active = session?.status === 'active' && !isLiveExpired(session, now);
  const target = points.peer;

  return (
    <div className="loc-layer" role="dialog" aria-modal="true" aria-label={sessionId ? 'Live location' : 'Location'}>
      <header className="loc-header">
        <button type="button" className="icon-button" onClick={onClose} aria-label="Back"><ArrowLeft size={20} /></button>
        <h2>{sessionId ? `Live location · ${peer?.name ?? ''}` : location?.name || 'Location'}</h2>
        {target && <a className="icon-button" href={externalMapUrl(target.lat, target.lon)} target="_blank" rel="noreferrer noopener" aria-label="Open in OpenStreetMap"><ExternalLink size={18} /></a>}
      </header>
      <div className="loc-map-wrap is-full">
        <div ref={containerRef} className="loc-map" />
      </div>
      <div className="loc-sheet loc-sheet-compact">
        {sessionId ? (
          <>
            <p className="loc-live-summary">
              {active
                ? <>{distance !== null ? <strong>{formatDistance(distance)} apart</strong> : <strong>Waiting for positions…</strong>} · ends in {formatRemaining(liveExpiresAt(session.startedAt, session.durationMs) - now)}</>
                : <strong>Live location {session?.endReason === 'expired' ? 'ended' : 'stopped'}</strong>}
            </p>
            <p className="loc-muted">
              {points.peer ? `${peer?.name ?? 'Contact'}: updated ${Math.max(0, Math.round((now - (points.peer.at ?? now)) / 1000))}s ago` : `${peer?.name ?? 'Contact'} has not shared a position yet`}
              {points.me ? ` · You: ±${formatDistance(points.me.accuracy ?? 0)}` : ''}
            </p>
            {active && send && <button type="button" className="loc-stop" onClick={() => stopLiveSession(sessionId, send)}><Square size={16} /> Stop sharing</button>}
          </>
        ) : (
          <p className="loc-live-summary"><strong>{location.name || 'Shared location'}</strong>{location.address ? ` · ${location.address}` : ''}</p>
        )}
        <p className="loc-attribution">Map data {OSM_ATTRIBUTION}</p>
      </div>
    </div>
  );
}
