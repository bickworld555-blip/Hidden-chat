// OpenStreetMap lookups: nearby places (Overpass) and a readable address (Nominatim).
// Both are public, keyless and rate-limited; results are cached per rounded position.
import { normalizePlaces, overpassQuery, shortAddress } from './geo.js';

export const OVERPASS_URLS = Object.freeze([
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
]);
export const OVERPASS_URL = OVERPASS_URLS[0];
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/reverse';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

const placesCache = new Map();
const addressCache = new Map();

const cacheKey = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

export const OVERPASS_ATTEMPT_TIMEOUT_MS = 12_000;

function attemptSignal(signal) {
  const timeout = AbortSignal.timeout(OVERPASS_ATTEMPT_TIMEOUT_MS);
  return signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal ?? timeout;
}

// Public Overpass instances are often overloaded; try each mirror until one answers.
export async function fetchNearbyPlaces(lat, lon, { signal, urls = OVERPASS_URLS } = {}) {
  const key = cacheKey(lat, lon);
  if (placesCache.has(key)) return placesCache.get(key);
  const body = `data=${encodeURIComponent(overpassQuery(lat, lon))}`;
  let lastError = null;
  for (const url of urls) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const response = await fetch(url, { method: 'POST', signal: attemptSignal(signal), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      if (!response.ok) throw new Error(`Overpass ${response.status}`);
      const places = normalizePlaces(await response.json(), { lat, lon });
      placesCache.set(key, places);
      return places;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      lastError = error;
    }
  }
  throw new Error(/429/.test(lastError?.message ?? '') ? 'Nearby places are busy right now. Try again in a moment.' : 'Nearby places are unavailable right now.');
}

export async function fetchAddress(lat, lon, { signal } = {}) {
  const key = cacheKey(lat, lon);
  if (addressCache.has(key)) return addressCache.get(key);
  const url = `${NOMINATIM_URL}?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`;
  const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Could not look up the address.');
  const address = shortAddress(await response.json());
  addressCache.set(key, address);
  return address;
}

export function clearPlacesCache() {
  placesCache.clear();
  addressCache.clear();
}
