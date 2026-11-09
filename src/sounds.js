// Playback engine: resolves what each category should sound like from the notification settings,
// then plays either a synthesized library tone or an uploaded file. Custom files live in IndexedDB.
import { get, set } from 'idb-keyval';
import { getNotificationSettings, soundPlan } from './notificationSettings.js';
import { nativeAlertsActive, nativePlaySystemSound, nativeStopSystemSound } from './native.js';
import { usesPhoneSound } from './phoneSounds.js';
import { ALERT_TONE, RINGBACK_TONE, SENT_TONE, TIMBRES, defaultToneForCategory, defaultToneId, resolveToneChoice, toneDuration } from './tones.js';

const CUSTOM_TONES_KEY = 'relay:custom-tones';
const LEGACY_PREFERENCES_KEY = 'relay:sound-preferences';
export const MAX_CUSTOM_TONE_BYTES = 10 * 1024 * 1024;

// Which library (notification sounds or ringtones) each playback category draws from.
export const CATEGORY_KINDS = Object.freeze({
  message: 'notification',
  reaction: 'notification',
  group: 'notification',
  status: 'notification',
  incomingCall: 'ringtone',
});

const activeTones = new Map();
let customCache = null;

// --- Custom tone files ----------------------------------------------------------------------------

export async function getCustomTones() {
  if (customCache) return customCache;
  let list = await get(CUSTOM_TONES_KEY);
  if (!Array.isArray(list)) {
    // Older builds stored one file per category; carry those over as named custom tones.
    const legacy = await get(LEGACY_PREFERENCES_KEY);
    list = [];
    for (const [category, record] of Object.entries(legacy ?? {})) {
      if (record?.blob) list.push({ id: `legacy-${category}`, name: record.name || category, kind: category === 'incomingCall' ? 'ringtone' : 'notification', blob: record.blob });
    }
    if (list.length) await set(CUSTOM_TONES_KEY, list);
  }
  customCache = list;
  return list;
}

export async function addCustomTone(file, kind) {
  if (!file) throw new Error('Choose an audio file.');
  if (file.size > MAX_CUSTOM_TONE_BYTES) throw new Error('Sound files must be 10 MB or smaller.');
  const audioMime = /^audio\//i.test(file.type);
  const audioExtension = /\.(mp3|wav|ogg|m4a|aac|flac|opus|weba)$/i.test(file.name);
  if (!audioMime && !audioExtension) throw new Error('Choose an MP3, WAV, OGG or M4A audio file.');
  const list = await getCustomTones();
  const tone = {
    id: crypto.randomUUID(),
    name: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Custom tone',
    kind: kind === 'ringtone' ? 'ringtone' : 'notification',
    blob: file.slice(0, file.size, file.type || 'audio/mpeg'),
  };
  customCache = [...list, tone];
  await set(CUSTOM_TONES_KEY, customCache);
  return tone;
}

export async function removeCustomTone(id) {
  const list = await getCustomTones();
  customCache = list.filter((tone) => tone.id !== id);
  await set(CUSTOM_TONES_KEY, customCache);
  return customCache;
}

// --- Playback -------------------------------------------------------------------------------------

function newRecord(key) {
  stopTone(key);
  const record = { stopped: false, timer: null, audio: null, context: null, url: null };
  activeTones.set(key, record);
  return record;
}

function playFile(key, record, blob, { loop, volume }) {
  try {
    record.url = URL.createObjectURL(blob);
    record.audio = new Audio(record.url);
    record.audio.loop = loop;
    record.audio.volume = volume;
    if (!loop) record.audio.addEventListener('ended', () => stopTone(key), { once: true });
    record.audio.play().catch(() => stopTone(key));
  } catch {
    stopTone(key);
  }
}

// Schedules every note of a synthesized tone once; ringtones repeat on their period.
function playSynth(key, record, tone, { loop, volume }) {
  const AudioContext = window.AudioContext ?? window.webkitAudioContext;
  if (!AudioContext) return;
  try {
    const context = new AudioContext();
    record.context = context;
    const master = context.createGain();
    master.gain.value = Math.max(0.0001, volume) * 0.3;
    master.connect(context.destination);
    const partials = TIMBRES[tone.timbre] ?? TIMBRES.plain;
    const playOnce = () => {
      if (record.stopped) return;
      const base = context.currentTime + 0.02;
      for (const [frequency, start, length, gain = 1] of tone.notes) {
        // The base wave plus each timbre partial, every voice with its own envelope.
        const voices = [{ ratio: 1, gain: 1, decay: 1 }, ...partials];
        for (const voice of voices) {
          const oscillator = context.createOscillator();
          const envelope = context.createGain();
          oscillator.type = voice.ratio === 1 ? (tone.wave ?? 'sine') : 'sine';
          oscillator.frequency.value = frequency * voice.ratio;
          const level = Math.max(0.0001, gain * voice.gain);
          const end = base + start + length * voice.decay;
          envelope.gain.setValueAtTime(0.0001, base + start);
          envelope.gain.exponentialRampToValueAtTime(level, base + start + 0.015);
          envelope.gain.exponentialRampToValueAtTime(0.0001, end);
          oscillator.connect(envelope);
          envelope.connect(master);
          oscillator.start(base + start);
          oscillator.stop(end + 0.02);
        }
      }
    };
    const duration = toneDuration(tone);
    context.resume().then(() => {
      if (record.stopped) return;
      playOnce();
      if (loop) record.timer = window.setInterval(playOnce, Math.max(duration + 0.4, tone.period ?? duration + 0.6) * 1000);
      else record.timer = window.setTimeout(() => stopTone(key), (duration + 0.3) * 1000);
    }).catch(() => stopTone(key));
  } catch {
    stopTone(key);
  }
}

// Plays an explicit choice (used by the picker previews). `key` lets the caller stop it later.
export async function playToneChoice(choice, kind, { loop = false, volume, key = `preview:${kind}`, defaultId = defaultToneId(kind) } = {}) {
  const record = newRecord(key);
  const custom = await getCustomTones();
  if (record.stopped || activeTones.get(key) !== record) return;
  const resolved = resolveToneChoice(choice, kind, custom, defaultId);
  const settings = getNotificationSettings();
  const level = volume ?? (kind === 'ringtone' ? settings.volume.ringtone : settings.volume.notification);
  if (resolved.kind === 'silent') return stopTone(key);
  if (resolved.kind === 'file') return playFile(key, record, resolved.custom.blob, { loop, volume: level });
  return playSynth(key, record, resolved.tone, { loop, volume: level });
}

// Plays what the settings say a category should sound like right now.
// Categories whose sound comes from an Android notification channel while the app is in the background.
const NATIVE_CHANNEL_CATEGORIES = new Set(['message', 'reaction', 'group', 'incomingCall']);

export async function playStoredTone(categoryId, { loop = categoryId === 'incomingCall' || categoryId === 'outgoingCall' } = {}) {
  if (NATIVE_CHANNEL_CATEGORIES.has(categoryId) && nativeAlertsActive()) return;
  const settings = getNotificationSettings();
  const plan = soundPlan(categoryId, settings);
  if (categoryId === 'outgoingCall') {
    const record = newRecord(categoryId);
    return playSynth(categoryId, record, RINGBACK_TONE, { loop, volume: plan.volume });
  }
  if (categoryId === 'alert' || categoryId === 'sent') {
    if (plan.tone === 'silent') return;
    const record = newRecord(categoryId);
    return playSynth(categoryId, record, categoryId === 'sent' ? SENT_TONE : ALERT_TONE, { loop: false, volume: plan.volume });
  }
  if (plan.tone === 'silent') return stopTone(categoryId);
  const kind = CATEGORY_KINDS[categoryId] ?? 'notification';
  // "Default" in the Android app: the phone's own ringtone / notification sound instead of a built-in tone.
  if (usesPhoneSound(categoryId, settings) && await playPhoneSound(categoryId, { ringtone: kind === 'ringtone', loop })) return undefined;
  return playToneChoice(plan.tone, kind, { loop, volume: plan.volume, key: categoryId, defaultId: defaultToneForCategory(categoryId, kind) });
}

// The phone's own default ringtone / notification sound (Android app only); stopTone(key) stops it.
export async function playPhoneSound(key, { ringtone = false, loop = false } = {}) {
  stopTone(key);
  activeTones.set(key, { native: true, stopped: false });
  const result = await nativePlaySystemSound({ key, ringtone, loop });
  if (result?.played) return true;
  activeTones.delete(key);
  return false;
}

export function stopTone(key) {
  const record = activeTones.get(key);
  if (!record) return;
  record.stopped = true;
  activeTones.delete(key);
  if (record.native) {
    nativeStopSystemSound(key);
    return;
  }
  window.clearTimeout(record.timer);
  window.clearInterval(record.timer);
  if (record.audio) {
    record.audio.pause();
    record.audio.src = '';
  }
  if (record.url) URL.revokeObjectURL(record.url);
  record.context?.close().catch(() => {});
}

export function stopAllTones() {
  for (const key of [...activeTones.keys()]) stopTone(key);
}

export function playNotificationTone(categoryId) {
  return playStoredTone(categoryId, { loop: false });
}

export async function previewTone(categoryId) {
  await playStoredTone(categoryId);
  window.setTimeout(() => stopTone(categoryId), 2200);
}

export function stopPreview(key) {
  stopTone(key);
}
