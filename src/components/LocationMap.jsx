// The full-screen map (Leaflet) for a shared or live location. Kept out of the main bundle: it loads only when a
// map is opened.
import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { ArrowLeft, ExternalLink, MapPin, MessageCircle, Navigation, Radio, Square, UserPlus } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { useChatStore } from '../store.js';
import { meIcon, peerIcon, useLeafletMap } from './LocationPicker.jsx';
import { externalMapUrl, formatDistance, formatRemaining, haversineDistance, isLiveExpired, liveExpiresAt, osmTileUrl, tileFor } from '../geo.js';
import { OSM_ATTRIBUTION } from '../places.js';

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
        layers.line = L.polyline(line, { color: '#005ad1', weight: 3, dashArray: '6 6' }).addTo(map);
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
