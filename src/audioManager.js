// Centralized global audio manager for exclusive playback
// Ensures that only one voice message or audio element can play at any given moment.

let currentPlayingId = null;
let currentStopCallback = null;

export function playExclusiveAudio(id, stopCallback) {
  if (currentStopCallback && currentPlayingId !== id) {
    try {
      currentStopCallback();
    } catch (err) {
      console.warn('[AudioManager] Error auto-pausing previous audio:', err);
    }
  }
  currentPlayingId = id;
  currentStopCallback = stopCallback;
}

export function stopExclusiveAudio(id) {
  if (currentPlayingId === id) {
    currentPlayingId = null;
    currentStopCallback = null;
  }
}

export function isAudioPlaying(id) {
  return currentPlayingId === id;
}

export function getCurrentlyPlayingId() {
  return currentPlayingId;
}
