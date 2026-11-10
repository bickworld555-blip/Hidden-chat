// Voice-note recording settings, like WhatsApp's Opus voice notes: a clean, levelled mono voice at a small size.
//
// The microphone is asked for echo cancellation, noise suppression and automatic gain control. On Android the
// WebView maps these to the phone's own audio effects (the hardware/vendor noise suppressor where there is one);
// a browser that cannot do one of them simply ignores it.

/** Opus at 32 kbit/s: clear speech at about 240 kB a minute (WhatsApp's notes are in the same range). */
export const VOICE_BITRATE = 32_000;

/** Preferred containers, best first. Opus in Ogg or WebM everywhere it exists; AAC in MP4 as the last resort. */
export const VOICE_FORMATS = Object.freeze([
  'audio/ogg;codecs=opus',
  'audio/webm;codecs=opus',
  'audio/mp4;codecs=opus',
  'audio/mp4',
]);

/** getUserMedia constraints for a voice note. `supported` is navigator.mediaDevices.getSupportedConstraints(). */
export function voiceAudioConstraints(supported = {}) {
  const audio = { channelCount: { ideal: 1 } };
  for (const feature of ['echoCancellation', 'noiseSuppression', 'autoGainControl']) {
    // Asked for unless the browser says it does not know the constraint at all.
    if (supported[feature] !== false) audio[feature] = { ideal: true };
  }
  if (supported.sampleRate) audio.sampleRate = { ideal: 48_000 };
  return { audio, video: false };
}

/** The first format this MediaRecorder can write, or '' to let it choose. */
export function pickVoiceFormat(Recorder = globalThis.MediaRecorder) {
  if (typeof Recorder?.isTypeSupported !== 'function') return '';
  return VOICE_FORMATS.find((format) => {
    try {
      return Recorder.isTypeSupported(format);
    } catch {
      return false;
    }
  }) ?? '';
}

/** MediaRecorder options: the chosen format and the voice bitrate. */
export function voiceRecorderOptions(Recorder = globalThis.MediaRecorder) {
  const mimeType = pickVoiceFormat(Recorder);
  return { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: VOICE_BITRATE };
}

/** Which of the voice-processing features the microphone actually turned on (for diagnostics and tests). */
export function appliedVoiceProcessing(track) {
  const settings = typeof track?.getSettings === 'function' ? track.getSettings() : {};
  return {
    echoCancellation: settings.echoCancellation === true,
    noiseSuppression: settings.noiseSuppression === true,
    autoGainControl: settings.autoGainControl === true,
  };
}

/**
 * Recording time that stops while paused: start → pause → resume → … → stop. `now` is injectable for tests.
 * elapsed() is the recorded length in seconds, never counting paused stretches.
 */
export function createRecordingClock(now = () => Date.now()) {
  let recorded = 0;
  let runningSince = null;
  return {
    start() {
      if (runningSince === null) runningSince = now();
    },
    pause() {
      if (runningSince === null) return;
      recorded += now() - runningSince;
      runningSince = null;
    },
    resume() {
      this.start();
    },
    get running() {
      return runningSince !== null;
    },
    elapsed() {
      return (recorded + (runningSince === null ? 0 : now() - runningSince)) / 1000;
    },
  };
}
