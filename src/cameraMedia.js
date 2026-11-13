// Helpers for the in-app camera (src/components/CameraCapture.jsx), kept free of React so tests can load them.

/** The first recording format this browser supports: MP4 where the phone can, else WebM ('' = the browser's own). */
export function cameraVideoType(isSupported = (type) => globalThis.MediaRecorder?.isTypeSupported?.(type)) {
  return ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((type) => isSupported(type)) ?? '';
}

/** "1:15" for a recording's length in seconds. */
export const clockOf = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
