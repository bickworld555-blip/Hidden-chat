// Renders the app's built-in synthesized tones to WAV files for the Android notification channels, so
// the native sounds match what the web app plays. Run: node scripts/generate-native-sounds.mjs
// Channel sounds are fixed when Android creates a channel; bump the channel ids in
// NotificationChannels.java if these files change after a release.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DEFAULT_GROUP_TONE, DEFAULT_NOTIFICATION_TONE, DEFAULT_RINGTONE, NOTIFICATION_TONES, RINGTONES, TIMBRES } from '../src/tones.js';

const RATE = 44_100;

function wave(type, phase) {
  const cycle = phase - Math.floor(phase);
  if (type === 'square') return cycle < 0.5 ? 1 : -1;
  if (type === 'sawtooth') return 2 * cycle - 1;
  if (type === 'triangle') return 1 - 4 * Math.abs(cycle - 0.5);
  return Math.sin(2 * Math.PI * cycle);
}

// Same voices and envelope as sounds.js playSynth: 15 ms exponential attack, exponential decay to the
// note end (scaled by each timbre partial's decay), partials as sines.
export function renderTone(tone, { seconds } = {}) {
  const partials = [{ ratio: 1, gain: 1, decay: 1 }, ...(TIMBRES[tone.timbre] ?? [])];
  const end = Math.max(...tone.notes.map(([, start, length]) => start + length)) + 0.05;
  const total = Math.ceil((seconds ?? end) * RATE);
  const mix = new Float64Array(total);
  for (const [frequency, start, length, gain = 1] of tone.notes) {
    for (const voice of partials) {
      const type = voice.ratio === 1 ? tone.wave ?? 'sine' : 'sine';
      const level = Math.max(0.0001, gain * voice.gain);
      const from = Math.floor(start * RATE);
      const duration = length * voice.decay;
      const to = Math.min(total, Math.ceil((start + duration) * RATE));
      for (let index = from; index < to; index += 1) {
        const t = index / RATE - start;
        const envelope = t < 0.015
          ? 0.0001 * (level / 0.0001) ** (t / 0.015)
          : level * (0.0001 / level) ** ((t - 0.015) / Math.max(0.001, duration - 0.015));
        mix[index] += wave(type, frequency * voice.ratio * t) * envelope;
      }
    }
  }
  const peak = mix.reduce((max, value) => Math.max(max, Math.abs(value)), 0) || 1;
  const pcm = Buffer.alloc(total * 2);
  for (let index = 0; index < total; index += 1) pcm.writeInt16LE(Math.round((mix[index] / peak) * 0.85 * 32767), index * 2);
  return wav(pcm);
}

function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const find = (list, id) => list.find((tone) => tone.id === id);
export const NATIVE_SOUNDS = [
  { file: 'normal_message.wav', tone: find(NOTIFICATION_TONES, DEFAULT_NOTIFICATION_TONE) },
  { file: 'group_message.wav', tone: find(NOTIFICATION_TONES, DEFAULT_GROUP_TONE) },
  // One full ringtone period; the call notification repeats it (FLAG_INSISTENT) until answered.
  { file: 'incoming_call_ringtone.wav', tone: find(RINGTONES, DEFAULT_RINGTONE), period: true },
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const { file, tone, period } of NATIVE_SOUNDS) {
    await writeFile(new URL(`../android/app/src/main/res/raw/${file}`, import.meta.url), renderTone(tone, period ? { seconds: tone.period } : {}));
  }
  console.log(`Wrote ${NATIVE_SOUNDS.length} sounds to android/app/src/main/res/raw/.`);
}
