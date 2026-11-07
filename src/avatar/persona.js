// The user's animated persona: which character they chose and the face-scan profile. Stored per device.
import { useSyncExternalStore } from 'react';
import { CHARACTERS, characterById } from './characters.js';

export const PERSONA_KEY = 'relay:avatar-persona';

const listeners = new Set();
let current = null;

export function normalizePersona(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const character = characterById(raw.characterId);
  if (!character) return null;
  const profile = raw.profile && typeof raw.profile === 'object' ? raw.profile : null;
  return {
    characterId: character.id,
    profile: profile ? {
      yawSign: profile.yawSign === -1 ? -1 : 1,
      pitchSign: profile.pitchSign === -1 ? -1 : 1,
      yawRange: clampNumber(profile.yawRange, 15, 60, 30),
      pitchRange: clampNumber(profile.pitchRange, 10, 45, 20),
      blinkMax: clampNumber(profile.blinkMax, 0.5, 1, 0.8),
    } : null,
    calibratedAt: typeof raw.calibratedAt === 'string' ? raw.calibratedAt : null,
  };
}

function clampNumber(value, min, max, fallback) {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function read() {
  if (current !== null) return current;
  let parsed = null;
  try { parsed = JSON.parse(globalThis.localStorage?.getItem(PERSONA_KEY) ?? 'null'); } catch { parsed = null; }
  current = normalizePersona(parsed) ?? false;
  return current;
}

export function getPersona() {
  const value = read();
  return value || null;
}

export function savePersona(persona) {
  const next = normalizePersona(persona);
  current = next ?? false;
  try {
    if (next) globalThis.localStorage?.setItem(PERSONA_KEY, JSON.stringify(next));
    else globalThis.localStorage?.removeItem(PERSONA_KEY);
  } catch {
    // Storage unavailable: the persona still applies for this session.
  }
  for (const listener of listeners) listener();
  return next;
}

export function clearPersona() {
  return savePersona(null);
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePersona() {
  const value = useSyncExternalStore(subscribe, read, () => false);
  return value || null;
}

export function personaCharacter(persona) {
  return characterById(persona?.characterId) ?? CHARACTERS[0];
}
