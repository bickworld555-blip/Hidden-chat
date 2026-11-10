// Live audio level from a MediaStream, read on demand (no React state, no timers): an AnalyserNode that the
// drawing loop samples once per animation frame. Used by the speaking ring in calls and the recorder waveform.

let sharedContext = null;

function audioContext() {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Context) return null;
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new Context();
  return sharedContext;
}

/** RMS level 0..1 of 8-bit time-domain samples (128 = silence), boosted so speech fills the range. */
export function levelFromSamples(samples, gain = 4) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (const value of samples) sum += ((value - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / samples.length) * gain);
}

/** Follows a level smoothly: quick to rise, slower to fall (like a VU meter), so the drawing does not jitter. */
export function smoothLevel(previous, next, rise = 0.6, fall = 0.15) {
  return previous + (next - previous) * (next > previous ? rise : fall);
}

/**
 * Starts metering a stream's audio. Returns { level(), stop() } or null where Web Audio or audio is missing.
 * The analyser is never connected to the speakers, so it adds no sound.
 */
export function meterStream(stream) {
  if (!stream?.getAudioTracks?.().length) return null;
  const context = audioContext();
  if (!context) return null;
  try {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    if (context.state === 'suspended') context.resume().catch(() => {});
    return {
      level() {
        analyser.getByteTimeDomainData(samples);
        return levelFromSamples(samples);
      },
      stop() {
        try { source.disconnect(); } catch { /* already gone */ }
      },
    };
  } catch {
    return null;
  }
}
