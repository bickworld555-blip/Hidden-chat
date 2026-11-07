import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ArrowLeft, Crosshair, LocateFixed, MapPin, Radio, Send, X } from 'lucide-react';
import { LIVE_COMMENT_MAX, LIVE_DURATIONS, formatDistance, isValidCoordinate } from '../geo.js';
import { OSM_ATTRIBUTION, fetchAddress, fetchNearbyPlaces } from '../places.js';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const meIcon = () => L.divIcon({ className: 'map-me', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] });
export const peerIcon = (initials) => L.divIcon({ className: 'map-peer', html: `<span>${initials ?? ''}</span>`, iconSize: [30, 30], iconAnchor: [15, 15] });

// Shared Leaflet bootstrap: an OSM layer with attribution, cleaned up on unmount.
export function useLeafletMap(containerRef, { center, zoom = 16 }) {
  const mapRef = useRef(null);
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return undefined;
    const map = L.map(containerRef.current, { zoomControl: false, attributionControl: true });
    map.attributionControl.setPrefix(false);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
    map.setView(center ?? [0, 0], center ? zoom : 2);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, [containerRef]);
  return mapRef;
}

// Location picker: pin follows the map centre; send it, share live, or pick a nearby place.
export default function LocationPicker({ onSendLocation, onShareLive, onClose }) {
  const containerRef = useRef(null);
  const accuracyRef = useRef(null);
  const [device, setDevice] = useState(null);
  const [selected, setSelected] = useState(null);
  const [address, setAddress] = useState('');
  const [places, setPlaces] = useState(null);
  const [placesError, setPlacesError] = useState('');
  const [error, setError] = useState('');
  const [durationOpen, setDurationOpen] = useState(false);
  const [durationId, setDurationId] = useState(LIVE_DURATIONS[0]);
  const [comment, setComment] = useState('');
  const mapRef = useLeafletMap(containerRef, { center: null });

  // Device position: centre the map once, then keep the dot updated.
  useEffect(() => {
    if (!navigator.geolocation) {
      setError('Location is not available in this browser.');
      return undefined;
    }
    let centred = false;
    const watch = navigator.geolocation.watchPosition(
      ({ coords }) => {
        const fix = { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy };
        setDevice(fix);
        setError('');
        if (!centred && mapRef.current) {
          centred = true;
          mapRef.current.setView([fix.lat, fix.lon], 16);
          setSelected(fix);
        }
      },
      (failure) => setError(failure.code === 1 ? 'Allow location access to share where you are.' : 'Could not get your location yet.'),
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [mapRef]);

  // The pin is fixed at the centre; dragging the map chooses another spot.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;
    const onMove = () => {
      const centre = map.getCenter();
      setSelected((current) => (current && Math.abs(current.lat - centre.lat) < 1e-7 && Math.abs(current.lon - centre.lng) < 1e-7
        ? current
        : { lat: centre.lat, lon: centre.lng, accuracy: null }));
    };
    map.on('moveend', onMove);
    return () => map.off('moveend', onMove);
  }, [mapRef]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !device) return undefined;
    const marker = L.marker([device.lat, device.lon], { icon: meIcon(), interactive: false }).addTo(map);
    accuracyRef.current?.remove();
    accuracyRef.current = device.accuracy ? L.circle([device.lat, device.lon], { radius: device.accuracy, weight: 1, color: '#0a84ff', fillOpacity: 0.08 }).addTo(map) : null;
    return () => { marker.remove(); accuracyRef.current?.remove(); accuracyRef.current = null; };
  }, [mapRef, device]);

  // Address and nearby places follow the selected spot.
  useEffect(() => {
    if (!selected) return undefined;
    const controller = new AbortController();
    setAddress('');
    setPlaces(null);
    setPlacesError('');
    fetchAddress(selected.lat, selected.lon, { signal: controller.signal }).then(setAddress).catch(() => {});
    fetchNearbyPlaces(selected.lat, selected.lon, { signal: controller.signal })
      .then(setPlaces)
      .catch((caught) => { if (!controller.signal.aborted) { setPlaces([]); setPlacesError(caught.message); } });
    return () => controller.abort();
  }, [selected?.lat, selected?.lon]);

  const recentre = () => {
    if (device && mapRef.current) mapRef.current.setView([device.lat, device.lon], 16);
  };

  const isDeviceSpot = device && selected && Math.abs(device.lat - selected.lat) < 1e-5 && Math.abs(device.lon - selected.lon) < 1e-5;

  return (
    <div className="loc-layer" role="dialog" aria-modal="true" aria-label="Share location">
      <header className="loc-header">
        <button type="button" className="icon-button" onClick={onClose} aria-label="Back"><ArrowLeft size={20} /></button>
        <h2>Send location</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </header>
      <div className="loc-map-wrap">
        <div ref={containerRef} className="loc-map" />
        <span className="loc-pin" aria-hidden="true"><MapPin size={34} /></span>
        <button type="button" className="loc-recentre" onClick={recentre} aria-label="Go to my location" disabled={!device}><LocateFixed size={20} /></button>
      </div>
      <div className="loc-sheet">
        {error && <p className="loc-error" role="alert">{error}</p>}
        <button type="button" className="loc-action" disabled={!selected} onClick={() => selected && onSendLocation({ ...selected, address: isDeviceSpot ? address : address || '' })}>
          <span className="loc-action-icon current"><Crosshair size={22} /></span>
          <span className="loc-action-text">
            <strong>{isDeviceSpot ? 'Send your current location' : 'Send this location'}</strong>
            <small>{address || (selected ? `${selected.lat.toFixed(5)}, ${selected.lon.toFixed(5)}` : 'Finding you…')}{isDeviceSpot && device?.accuracy ? ` · Accurate to ${formatDistance(device.accuracy)}` : ''}</small>
          </span>
        </button>
        <button type="button" className="loc-action" disabled={!device} onClick={() => setDurationOpen((open) => !open)} aria-expanded={durationOpen}>
          <span className="loc-action-icon live"><Radio size={22} /></span>
          <span className="loc-action-text">
            <strong>Share live location</strong>
            <small>Your contact must accept before anyone's position is shared</small>
          </span>
        </button>
        {durationOpen && (
          <form className="loc-live-sheet" onSubmit={(event) => { event.preventDefault(); onShareLive(durationId.ms, comment); }}>
            <p className="loc-live-lead">Your live location will be shared with this chat for <strong>{durationId.label}</strong>. Updates are sent only while this app is open, and the distance between you both appears on the map once accepted.</p>
            <span className="loc-live-label">Share live location for</span>
            <div className="loc-durations" role="radiogroup" aria-label="Share live location for">
              {LIVE_DURATIONS.map((duration) => (
                <button type="button" key={duration.id} role="radio" aria-checked={duration.id === durationId.id} className={duration.id === durationId.id ? 'selected' : ''} onClick={() => setDurationId(duration)}>{duration.label}</button>
              ))}
            </div>
            <div className="loc-live-footer">
              <input value={comment} onChange={(event) => setComment(event.target.value)} maxLength={LIVE_COMMENT_MAX} placeholder="Add comment (optional)" aria-label="Add comment" />
              <button type="submit" className="loc-live-send" aria-label="Share live location"><Send size={20} /></button>
            </div>
          </form>
        )}
        <h3 className="loc-nearby-title">Nearby places</h3>
        {places === null && !placesError && <p className="loc-muted">Looking around…</p>}
        {placesError && <p className="loc-muted">{placesError}</p>}
        {places?.length === 0 && !placesError && <p className="loc-muted">No named places nearby.</p>}
        <ul className="loc-places">
          {(places ?? []).map((place) => (
            <li key={place.id}>
              <button type="button" onClick={() => isValidCoordinate(place.lat, place.lon) && onSendLocation({ lat: place.lat, lon: place.lon, name: place.name, address: place.address || place.category })}>
                <span className="loc-place-icon"><MapPin size={18} /></span>
                <span className="loc-place-text">
                  <strong>{place.name}</strong>
                  <small>{[place.category, place.address, formatDistance(place.distance)].filter(Boolean).join(' · ')}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="loc-attribution">Map data {OSM_ATTRIBUTION}</p>
      </div>
    </div>
  );
}
