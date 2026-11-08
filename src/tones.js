// Built-in tone library. Every tone is an original synthesized sequence (no recordings), described as
// notes so the same definition drives playback, previews and tests.
// note: [frequencyHz, startSeconds, lengthSeconds, gain?]  wave: oscillator type
// timbre adds harmonic partials on top of the base wave for a fuller sound:
//   bell  → inharmonic partials with a long shimmer   pluck → bright octave that decays fast   pad → soft detuned chorus

const N = (frequency, start, length, gain = 1) => [frequency, start, length, gain];

export const TIMBRES = Object.freeze({
  plain: [],
  bell: [{ ratio: 2.76, gain: 0.35, decay: 0.6 }, { ratio: 5.4, gain: 0.15, decay: 0.4 }],
  pluck: [{ ratio: 2, gain: 0.4, decay: 0.3 }, { ratio: 3, gain: 0.15, decay: 0.2 }],
  pad: [{ ratio: 1.004, gain: 0.6, decay: 1 }, { ratio: 0.996, gain: 0.6, decay: 1 }, { ratio: 2.002, gain: 0.2, decay: 1 }],
});

export const NOTIFICATION_TONES = Object.freeze([
  { id: 'pulse-beam', name: 'Pulse Beam', wave: 'sine', timbre: 'pluck', notes: [N(880, 0, 0.09), N(1320, 0.12, 0.16)] },
  { id: 'crystal-bells', name: 'Crystal Bells', wave: 'triangle', timbre: 'bell', notes: [N(1568, 0, 0.18), N(2093, 0.16, 0.22), N(2637, 0.34, 0.3, 0.8)] },
  { id: 'eight-bit-hop', name: '8-bit Hop', wave: 'square', notes: [N(523, 0, 0.07, 0.5), N(659, 0.08, 0.07, 0.5), N(784, 0.16, 0.07, 0.5), N(1047, 0.24, 0.14, 0.5)] },
  { id: 'visitor', name: 'Visitor', wave: 'sawtooth', notes: [N(440, 0, 0.12, 0.35), N(466, 0.12, 0.12, 0.35), N(494, 0.24, 0.2, 0.35)] },
  { id: 'alpha-wave', name: 'Alpha Wave', wave: 'sine', timbre: 'pad', notes: [N(659, 0, 0.22), N(988, 0.2, 0.3)] },
  { id: 'meteor', name: 'Meteor', wave: 'triangle', notes: [N(1760, 0, 0.08), N(1480, 0.08, 0.08), N(1175, 0.16, 0.08), N(880, 0.24, 0.22)] },
  { id: 'atom-chime', name: 'Atom Chime', wave: 'sine', timbre: 'bell', notes: [N(1319, 0, 0.1), N(1319, 0.14, 0.1), N(1760, 0.3, 0.28)] },
  { id: 'dawn', name: 'Dawn', wave: 'sine', timbre: 'pad', notes: [N(523, 0, 0.3, 0.7), N(659, 0.1, 0.3, 0.7), N(784, 0.2, 0.4, 0.7)] },
  { id: 'single-beep', name: 'Single Beep', wave: 'sine', notes: [N(1000, 0, 0.14)] },
  { id: 'double-beep', name: 'Double Beep', wave: 'sine', notes: [N(1000, 0, 0.09), N(1000, 0.16, 0.09)] },
  { id: 'north-star', name: 'North Star', wave: 'triangle', timbre: 'bell', notes: [N(987, 0, 0.12), N(1318, 0.12, 0.12), N(1976, 0.24, 0.3)] },
  { id: 'tangle', name: 'Tangle', wave: 'square', notes: [N(740, 0, 0.05, 0.4), N(932, 0.06, 0.05, 0.4), N(740, 0.12, 0.05, 0.4), N(1109, 0.18, 0.16, 0.4)] },
  { id: 'tea-time', name: 'Tea Time', wave: 'triangle', timbre: 'bell', notes: [N(1047, 0, 0.16), N(784, 0.18, 0.16), N(1047, 0.36, 0.3)] },
  { id: 'streak', name: 'Streak', wave: 'sine', timbre: 'pluck', notes: [N(660, 0, 0.06), N(880, 0.06, 0.06), N(1100, 0.12, 0.06), N(1320, 0.18, 0.06), N(1760, 0.24, 0.2)] },
  { id: 'ping', name: 'Ping', wave: 'sine', timbre: 'bell', notes: [N(1480, 0, 0.26, 0.9)] },
  { id: 'deep-space', name: 'Deep Space', wave: 'sawtooth', timbre: 'pad', notes: [N(220, 0, 0.3, 0.3), N(330, 0.2, 0.3, 0.3), N(440, 0.4, 0.4, 0.3)] },
  { id: 'orbit', name: 'Orbit', wave: 'sine', timbre: 'pluck', notes: [N(784, 0, 0.1), N(1175, 0.1, 0.1), N(784, 0.2, 0.1), N(1175, 0.3, 0.24)] },
  { id: 'glimmer', name: 'Glimmer', wave: 'triangle', timbre: 'bell', notes: [N(2093, 0, 0.06, 0.7), N(2637, 0.07, 0.06, 0.7), N(3136, 0.14, 0.06, 0.7), N(2637, 0.21, 0.2, 0.7)] },
  { id: 'droplet', name: 'Droplet', wave: 'sine', timbre: 'pluck', notes: [N(1976, 0, 0.05, 0.8), N(1319, 0.06, 0.22, 0.8)] },
  { id: 'harbor', name: 'Harbor', wave: 'triangle', timbre: 'pad', notes: [N(392, 0, 0.35, 0.6), N(494, 0.05, 0.35, 0.6), N(587, 0.1, 0.45, 0.6)] },
  { id: 'kettle', name: 'Kettle', wave: 'square', notes: [N(1480, 0, 0.04, 0.35), N(1480, 0.07, 0.04, 0.35), N(1480, 0.14, 0.04, 0.35), N(1975, 0.22, 0.18, 0.35)] },
  { id: 'lantern', name: 'Lantern', wave: 'sine', timbre: 'bell', notes: [N(1175, 0, 0.2), N(1568, 0.22, 0.34)] },
  { id: 'marimba', name: 'Marimba', wave: 'sine', timbre: 'pluck', notes: [N(698, 0, 0.1), N(880, 0.1, 0.1), N(1047, 0.2, 0.1), N(880, 0.3, 0.18)] },
  { id: 'nudge', name: 'Nudge', wave: 'triangle', notes: [N(600, 0, 0.08, 0.7), N(900, 0.1, 0.14, 0.7)] },
  { id: 'quartz', name: 'Quartz', wave: 'sine', timbre: 'bell', notes: [N(2637, 0, 0.12, 0.6), N(2093, 0.12, 0.12, 0.6), N(2637, 0.24, 0.28, 0.6)] },
  { id: 'signal', name: 'Signal', wave: 'sawtooth', notes: [N(880, 0, 0.1, 0.3), N(1109, 0.12, 0.1, 0.3), N(1319, 0.24, 0.2, 0.3)] },
  { id: 'sprout', name: 'Sprout', wave: 'sine', timbre: 'pluck', notes: [N(1047, 0, 0.07), N(1319, 0.08, 0.07), N(1568, 0.16, 0.07), N(2093, 0.24, 0.2)] },
  { id: 'tide', name: 'Tide', wave: 'triangle', timbre: 'pad', notes: [N(440, 0, 0.5, 0.5), N(554, 0.15, 0.45, 0.5), N(659, 0.3, 0.5, 0.5)] },
  { id: 'whistle', name: 'Whistle', wave: 'sine', notes: [N(1760, 0, 0.12, 0.6), N(2217, 0.1, 0.22, 0.6)] },
  { id: 'wink', name: 'Wink', wave: 'triangle', timbre: 'pluck', notes: [N(1319, 0, 0.06), N(1760, 0.07, 0.16)] },
]);

// Ringtones loop; `period` is the gap between repeats.
export const RINGTONES = Object.freeze([
  { id: 'beyond-the-skyline', name: 'Beyond the Skyline', wave: 'sine', timbre: 'pad', period: 2.6, notes: [N(659, 0, 0.22), N(784, 0.24, 0.22), N(988, 0.48, 0.22), N(1319, 0.72, 0.5), N(988, 1.3, 0.22), N(1175, 1.54, 0.5)] },
  { id: 'long-voyage', name: 'Long Voyage', wave: 'triangle', timbre: 'pad', period: 3, notes: [N(523, 0, 0.35), N(659, 0.4, 0.35), N(784, 0.8, 0.6), N(698, 1.5, 0.35), N(659, 1.9, 0.6)] },
  { id: 'lunar-landing', name: 'Lunar Landing', wave: 'sine', timbre: 'pluck', period: 2.4, notes: [N(440, 0, 0.18), N(554, 0.2, 0.18), N(659, 0.4, 0.18), N(880, 0.6, 0.6), N(659, 1.3, 0.4)] },
  { id: 'quantum-bell', name: 'Quantum Bell', wave: 'triangle', timbre: 'bell', period: 2, notes: [N(1568, 0, 0.3), N(1319, 0.35, 0.3), N(1568, 0.7, 0.3), N(2093, 1.05, 0.6)] },
  { id: 'asteroid-field', name: 'Asteroid Field', wave: 'square', period: 2.2, notes: [N(392, 0, 0.12, 0.4), N(523, 0.14, 0.12, 0.4), N(659, 0.28, 0.12, 0.4), N(784, 0.42, 0.3, 0.4), N(659, 0.8, 0.12, 0.4), N(784, 0.94, 0.4, 0.4)] },
  { id: 'atomic-ring', name: 'Atomic Ring', wave: 'sine', timbre: 'bell', period: 1.8, notes: [N(1319, 0, 0.15), N(1319, 0.2, 0.15), N(1760, 0.4, 0.15), N(1760, 0.6, 0.4)] },
  { id: 'comet-tail', name: 'Comet Tail', wave: 'sawtooth', timbre: 'pad', period: 2.8, notes: [N(330, 0, 0.3, 0.3), N(440, 0.3, 0.3, 0.3), N(554, 0.6, 0.3, 0.3), N(659, 0.9, 0.7, 0.3), N(554, 1.7, 0.5, 0.3)] },
  { id: 'cosmos-waltz', name: 'Cosmos Waltz', wave: 'triangle', timbre: 'pad', period: 3.2, notes: [N(587, 0, 0.3), N(740, 0.35, 0.3), N(880, 0.7, 0.3), N(1175, 1.05, 0.8), N(880, 1.95, 0.3), N(740, 2.3, 0.5)] },
  { id: 'homeward', name: 'Homeward', wave: 'sine', timbre: 'pluck', period: 2.5, notes: [N(784, 0, 0.25), N(659, 0.3, 0.25), N(523, 0.6, 0.45), N(659, 1.1, 0.25), N(784, 1.4, 0.6)] },
  { id: 'classic-ring', name: 'Classic Ring', wave: 'sine', period: 2.4, notes: [N(660, 0, 0.45), N(880, 0, 0.45), N(660, 0.55, 0.45), N(880, 0.55, 0.45)] },
  { id: 'carillon', name: 'Carillon', wave: 'triangle', timbre: 'bell', period: 3, notes: [N(1047, 0, 0.5), N(784, 0.5, 0.5), N(880, 1, 0.5), N(523, 1.5, 0.9)] },
  { id: 'daybreak', name: 'Daybreak', wave: 'sine', timbre: 'pad', period: 3.4, notes: [N(392, 0, 0.6, 0.7), N(494, 0.3, 0.6, 0.7), N(587, 0.6, 0.6, 0.7), N(784, 1.1, 1, 0.7), N(587, 2.2, 0.6, 0.7)] },
  { id: 'echo-chamber', name: 'Echo Chamber', wave: 'sine', timbre: 'pluck', period: 2.6, notes: [N(988, 0, 0.14), N(988, 0.3, 0.14, 0.6), N(988, 0.6, 0.14, 0.35), N(1319, 0.9, 0.5), N(1319, 1.4, 0.4, 0.5)] },
  { id: 'festival', name: 'Festival', wave: 'square', period: 2.4, notes: [N(523, 0, 0.14, 0.4), N(659, 0.16, 0.14, 0.4), N(784, 0.32, 0.14, 0.4), N(1047, 0.48, 0.3, 0.4), N(784, 0.84, 0.14, 0.4), N(1047, 1, 0.14, 0.4), N(1319, 1.16, 0.5, 0.4)] },
  { id: 'glacier', name: 'Glacier', wave: 'triangle', timbre: 'bell', period: 3.6, notes: [N(1568, 0, 0.7, 0.8), N(1175, 0.8, 0.7, 0.8), N(1319, 1.6, 1.2, 0.8)] },
  { id: 'night-market', name: 'Night Market', wave: 'sawtooth', timbre: 'pluck', period: 2.5, notes: [N(440, 0, 0.16, 0.3), N(523, 0.18, 0.16, 0.3), N(587, 0.36, 0.16, 0.3), N(659, 0.54, 0.5, 0.3), N(587, 1.1, 0.16, 0.3), N(523, 1.28, 0.5, 0.3)] },
  { id: 'old-telephone', name: 'Old Telephone', wave: 'sine', period: 3, notes: [N(1209, 0, 0.9, 0.6), N(1336, 0, 0.9, 0.6), N(1209, 1, 0.9, 0.6), N(1336, 1, 0.9, 0.6)] },
  { id: 'summit', name: 'Summit', wave: 'sine', timbre: 'pad', period: 3.2, notes: [N(523, 0, 0.3), N(659, 0.3, 0.3), N(784, 0.6, 0.3), N(1047, 0.9, 0.3), N(1319, 1.2, 1), N(1047, 2.3, 0.5)] },
]);

export const DEFAULT_NOTIFICATION_TONE = 'pulse-beam';
export const DEFAULT_RINGTONE = 'beyond-the-skyline';
// Group messages default to a different tone so a glance-free listener can tell them from direct chats.
export const DEFAULT_GROUP_TONE = 'crystal-bells';
export const SENT_TONE = Object.freeze({ id: 'sent', name: 'Sent', wave: 'sine', notes: [N(1047, 0, 0.05, 0.4), N(1568, 0.05, 0.08, 0.4)] });
export const RINGBACK_TONE = Object.freeze({ id: 'ringback', name: 'Ringback', wave: 'sine', period: 3, notes: [N(440, 0, 1, 0.5), N(480, 0, 1, 0.5)] });
export const ALERT_TONE = Object.freeze({ id: 'alert', name: 'Alert', wave: 'sine', notes: [N(520, 0, 0.16), N(760, 0.2, 0.2)] });

export function toneLibrary(kind) {
  return kind === 'ringtone' ? RINGTONES : NOTIFICATION_TONES;
}

export function defaultToneId(kind) {
  return kind === 'ringtone' ? DEFAULT_RINGTONE : DEFAULT_NOTIFICATION_TONE;
}

// The library tone a playback category's "Default" choice means.
export function defaultToneForCategory(category, kind) {
  return category === 'group' ? DEFAULT_GROUP_TONE : defaultToneId(kind);
}

export function libraryTone(kind, id) {
  return toneLibrary(kind).find((tone) => tone.id === id) ?? null;
}

export function toneDuration(tone) {
  return tone.notes.reduce((end, [, start, length]) => Math.max(end, start + length), 0);
}

export function isCustomChoice(choice) {
  return typeof choice === 'string' && choice.startsWith('custom:');
}

export function customChoiceId(choice) {
  return isCustomChoice(choice) ? choice.slice('custom:'.length) : null;
}

// Turns a stored choice into something playable: { kind: 'silent' } | { kind: 'synth', tone } | { kind: 'file', custom }.
// Missing custom files or unknown ids fall back to the library default rather than silence.
export function resolveToneChoice(choice, kind, customTones = [], defaultId = defaultToneId(kind)) {
  if (choice === 'silent') return { kind: 'silent', label: 'Silent' };
  if (isCustomChoice(choice)) {
    const custom = customTones.find((item) => item.id === customChoiceId(choice));
    if (custom) return { kind: 'file', custom, label: custom.name };
  }
  if (choice && choice !== 'default') {
    const tone = libraryTone(kind, choice);
    if (tone) return { kind: 'synth', tone, label: tone.name };
  }
  const tone = libraryTone(kind, defaultId) ?? libraryTone(kind, defaultToneId(kind));
  return { kind: 'synth', tone, label: `Default (${tone.name})` };
}

export function toneChoiceLabel(choice, kind, customTones = [], defaultId = defaultToneId(kind)) {
  return resolveToneChoice(choice, kind, customTones, defaultId).label;
}
