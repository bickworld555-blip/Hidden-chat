// Location and contact sharing: message payloads, distance maths, live-session rules and map helpers.
// Pure functions only; the UI, the server and the tests all read the same definitions.

export const EARTH_RADIUS_M = 6_371_000;

export const LIVE_DURATIONS = Object.freeze([
  { id: '15m', label: '15 minutes', ms: 15 * 60 * 1000 },
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '8h', label: '8 hours', ms: 8 * 60 * 60 * 1000 },
]);

export const LIVE_UPDATE_MIN_INTERVAL_MS = 3000;
export const LIVE_UPDATE_MIN_DISTANCE_M = 5;
export const NEARBY_RADIUS_M = 600;
export const NEARBY_LIMIT = 20;
export const STATIC_MAP_ZOOM = 15;

export function isValidCoordinate(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

const toRadians = (degrees) => (degrees * Math.PI) / 180;

// Great-circle distance in metres between two { lat, lon } points.
export function haversineDistance(a, b) {
  if (!a || !b || !isValidCoordinate(a.lat, a.lon) || !isValidCoordinate(b.lat, b.lon)) return null;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function formatDistance(metres) {
  if (!Number.isFinite(metres) || metres < 0) return '';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(metres < 10_000 ? 1 : 0)} km`;
}

export function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'ended';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

// --- Message payloads -----------------------------------------------------------------------------

function parseJsonPayload(content, prefix) {
  if (typeof content !== 'string' || !content.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(content.slice(prefix.length));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

const round = (value) => Math.round(value * 1e6) / 1e6;

export function locationContent({ lat, lon, accuracy, name, address }) {
  if (!isValidCoordinate(lat, lon)) throw new Error('A valid position is required.');
  const payload = { lat: round(lat), lon: round(lon) };
  if (Number.isFinite(accuracy)) payload.accuracy = Math.round(accuracy);
  if (name) payload.name = String(name).slice(0, 120);
  if (address) payload.address = String(address).slice(0, 200);
  return `location:${JSON.stringify(payload)}`;
}

export function parseLocation(content) {
  const payload = parseJsonPayload(content, 'location:');
  if (!payload || !isValidCoordinate(payload.lat, payload.lon)) return null;
  return {
    lat: payload.lat,
    lon: payload.lon,
    accuracy: Number.isFinite(payload.accuracy) ? payload.accuracy : null,
    name: typeof payload.name === 'string' ? payload.name : '',
    address: typeof payload.address === 'string' ? payload.address : '',
  };
}

export const LIVE_COMMENT_MAX = 200;

export function normalizeLiveComment(comment) {
  return String(comment ?? '').replace(/\s+/g, ' ').trim().slice(0, LIVE_COMMENT_MAX);
}

export function liveContent({ sessionId, durationMs, startedAt, comment }) {
  const payload = { sessionId, durationMs, startedAt };
  const note = normalizeLiveComment(comment);
  if (note) payload.comment = note;
  return `live:${JSON.stringify(payload)}`;
}

export function parseLive(content) {
  const payload = parseJsonPayload(content, 'live:');
  if (!payload || typeof payload.sessionId !== 'string' || !Number.isFinite(payload.durationMs)) return null;
  return {
    sessionId: payload.sessionId,
    durationMs: payload.durationMs,
    startedAt: payload.startedAt ?? null,
    comment: typeof payload.comment === 'string' ? normalizeLiveComment(payload.comment) : '',
  };
}

export function contactContent(contact) {
  const payload = {
    id: String(contact.id ?? ''),
    name: String(contact.name ?? '').slice(0, 120),
    username: contact.username ? String(contact.username).slice(0, 40) : '',
    initials: contact.initials ? String(contact.initials).slice(0, 3) : '',
    color: contact.color ? String(contact.color).slice(0, 20) : '',
    avatar: typeof contact.avatar === 'string' ? contact.avatar : null,
  };
  return `contact:${JSON.stringify(payload)}`;
}

export function parseContact(content) {
  const payload = parseJsonPayload(content, 'contact:');
  if (!payload || typeof payload.name !== 'string' || !payload.name) return null;
  return {
    id: typeof payload.id === 'string' ? payload.id : '',
    name: payload.name,
    username: typeof payload.username === 'string' ? payload.username : '',
    initials: typeof payload.initials === 'string' && payload.initials ? payload.initials : payload.name.slice(0, 2).toUpperCase(),
    color: typeof payload.color === 'string' && payload.color ? payload.color : 'blue',
    avatar: typeof payload.avatar === 'string' ? payload.avatar : null,
  };
}

export function messageKind(content) {
  if (typeof content !== 'string') return 'text';
  if (content.startsWith('location:')) return 'location';
  if (content.startsWith('live:')) return 'live';
  if (content.startsWith('contact:')) return 'contact';
  return 'text';
}

// --- Live sessions ----------------------------------------------------------------------------------

export function liveExpiresAt(startedAt, durationMs) {
  const start = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
  return Number.isFinite(start) ? start + durationMs : null;
}

export function isLiveExpired(session, now = Date.now()) {
  const expiresAt = liveExpiresAt(session.startedAt, session.durationMs);
  return expiresAt !== null && now >= expiresAt;
}

// Whether a new fix is worth sending: enough time passed, or the device moved far enough.
export function shouldSendLiveUpdate(previous, next, now = Date.now()) {
  if (!previous) return true;
  const elapsed = now - previous.at;
  if (elapsed < LIVE_UPDATE_MIN_INTERVAL_MS) return false;
  const moved = haversineDistance(previous, next);
  return moved === null || moved >= LIVE_UPDATE_MIN_DISTANCE_M || elapsed >= LIVE_UPDATE_MIN_INTERVAL_MS * 5;
}

// --- Map helpers ----------------------------------------------------------------------------------

// Slippy-map tile that contains a point, plus the pixel offset of the point inside that tile.
export function tileFor(lat, lon, zoom = STATIC_MAP_ZOOM) {
  const n = 2 ** zoom;
  const x = ((lon + 180) / 360) * n;
  const latRad = toRadians(lat);
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { zoom, x: Math.floor(x), y: Math.floor(y), offsetX: (x - Math.floor(x)) * 256, offsetY: (y - Math.floor(y)) * 256 };
}

export function osmTileUrl({ zoom, x, y }) {
  return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
}

export function externalMapUrl(lat, lon) {
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}

export function googleMapsUrl(lat, lon) {
  return `https://maps.google.com/?q=${lat},${lon}`;
}

// --- Nearby places (OpenStreetMap Overpass) ---------------------------------------------------------

export function overpassQuery(lat, lon, radius = NEARBY_RADIUS_M) {
  const around = `(around:${radius},${lat},${lon})`;
  // Four cheap clauses: named amenities, shops, tourism and leisure spots (nodes, ways and relations).
  return `[out:json][timeout:8];(
    nwr["name"]["amenity"~"^(cafe|restaurant|fast_food|bar|pub|school|college|university|hospital|clinic|pharmacy|bank|library|place_of_worship|cinema|marketplace|fuel|bus_station)$"]${around};
    nwr["name"]["shop"]${around};
    nwr["name"]["tourism"]${around};
    nwr["name"]["leisure"~"^(park|stadium|sports_centre|playground)$"]${around};
  );out center ${NEARBY_LIMIT * 3};`;
}

const CATEGORY_LABELS = { cafe: 'Café', fast_food: 'Fast food', place_of_worship: 'Place of worship', sports_centre: 'Sports centre', bus_station: 'Bus station', fuel: 'Fuel station' };

function categoryLabel(tags) {
  const raw = tags.amenity ?? tags.shop ?? tags.tourism ?? tags.leisure ?? '';
  if (!raw) return '';
  return CATEGORY_LABELS[raw] ?? raw.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

// Turns an Overpass response into a de-duplicated list sorted by distance from the user.
export function normalizePlaces(overpass, origin, limit = NEARBY_LIMIT) {
  const elements = Array.isArray(overpass?.elements) ? overpass.elements : [];
  const seen = new Set();
  const places = [];
  for (const element of elements) {
    const name = element.tags?.name;
    const lat = element.lat ?? element.center?.lat;
    const lon = element.lon ?? element.center?.lon;
    if (!name || !isValidCoordinate(lat, lon)) continue;
    const key = `${name.toLowerCase()}|${round(lat).toFixed(4)}|${round(lon).toFixed(4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const street = [element.tags['addr:housenumber'], element.tags['addr:street']].filter(Boolean).join(' ');
    places.push({
      id: `${element.type}/${element.id}`,
      name,
      category: categoryLabel(element.tags),
      address: street || element.tags['addr:full'] || '',
      lat,
      lon,
      distance: haversineDistance(origin, { lat, lon }),
    });
  }
  return places.sort((left, right) => (left.distance ?? Infinity) - (right.distance ?? Infinity)).slice(0, limit);
}

// A short human address from a Nominatim reverse-geocode response.
export function shortAddress(nominatim) {
  const address = nominatim?.address;
  if (!address) return nominatim?.display_name ?? '';
  const parts = [
    [address.house_number, address.road].filter(Boolean).join(' '),
    address.neighbourhood || address.suburb,
    address.city || address.town || address.village,
  ].filter(Boolean);
  return parts.join(', ') || nominatim.display_name || '';
}
