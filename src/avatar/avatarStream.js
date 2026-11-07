// The avatar video filter: camera track in, cartoon track out. One render loop per filter tracks the face,
// smooths the expression, draws the chosen character and reports fps/latency. The output is a
// canvas.captureStream() track, so the peer just receives ordinary video.
import { drawAvatar, idleExpression } from './characters.js';
import { expressionFromResult, smoothExpression, NEUTRAL_EXPRESSION } from './expression.js';
import { personalize } from './calibration.js';

export const AVATAR_SIZE = 480;
export const AVATAR_FPS = 30;

// Running averages for the badge: frames per second and tracking latency per frame.
export function createStats() {
  let frames = 0;
  let windowStart = 0;
  let latencySum = 0;
  const stats = { fps: 0, latencyMs: 0, tracking: false };
  return {
    stats,
    record(now, latencyMs, tracking) {
      if (!windowStart) windowStart = now;
      frames += 1;
      latencySum += latencyMs;
      stats.tracking = tracking;
      if (now - windowStart >= 1000) {
        stats.fps = Math.round((frames * 1000) / (now - windowStart));
        stats.latencyMs = Math.round(latencySum / frames);
        frames = 0;
        latencySum = 0;
        windowStart = now;
      }
    },
  };
}

// Picks the frame driver: per-video-frame callbacks when available (no wasted work), else rAF.
function frameDriver(video, callback) {
  let cancelled = false;
  let handle = null;
  if (typeof video.requestVideoFrameCallback === 'function') {
    const tick = (now) => { if (cancelled) return; callback(now); handle = video.requestVideoFrameCallback(tick); };
    handle = video.requestVideoFrameCallback(tick);
    return () => { cancelled = true; try { video.cancelVideoFrameCallback?.(handle); } catch {} };
  }
  const tick = (now) => { if (cancelled) return; callback(now); handle = requestAnimationFrame(tick); };
  handle = requestAnimationFrame(tick);
  return () => { cancelled = true; cancelAnimationFrame(handle); };
}

// `factory` for callEngine.setVideoFilter(): returns a fresh filter whose output track mirrors the camera
// through the character. `tracker` comes from loadFaceTracker(); when it is missing the avatar idles.
export function createAvatarFilter({ character, profile = null, tracker = null, size = AVATAR_SIZE, fps = AVATAR_FPS, onStats, documentRef = globalThis.document } = {}) {
  const canvas = documentRef.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const video = documentRef.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  const statsBox = createStats();
  let release = null;
  let stopFrames = null;
  let outputStream = null;
  let smoothed = null;
  let lastSeen = 0;
  let disposed = false;

  function render(now) {
    if (disposed) return;
    const t0 = performance.now();
    let expression = null;
    if (tracker && video.readyState >= 2 && video.videoWidth) {
      try {
        const result = tracker.detect(video, now || t0);
        expression = expressionFromResult(result);
      } catch {
        expression = null;
      }
    }
    const tracking = Boolean(expression?.present);
    if (tracking) lastSeen = t0;
    // Keep the last pose briefly when the face drops out, then ease into the idle animation.
    const target = tracking ? expression : (t0 - lastSeen < 600 && smoothed ? { ...smoothed, present: false } : idleExpression(t0));
    smoothed = smoothExpression(smoothed, target);
    drawAvatar(ctx, character, personalize(smoothed, profile), size);
    statsBox.record(t0, performance.now() - t0, tracking);
    onStats?.(statsBox.stats);
  }

  async function attach(track) {
    video.srcObject = new MediaStream([track]);
    try { await video.play(); } catch {}
  }

  return {
    canvas,
    get stats() { return statsBox.stats; },
    async start(track) {
      if (disposed) throw new Error('Avatar filter was stopped.');
      release = tracker?.acquire?.() ?? null;
      await attach(track);
      outputStream = canvas.captureStream(fps);
      const [output] = outputStream.getVideoTracks();
      // Draw once immediately so the first frame the peer sees is already the character.
      drawAvatar(ctx, character, personalize({ ...NEUTRAL_EXPRESSION }, profile), size);
      stopFrames = frameDriver(video, render);
      return output;
    },
    async setInput(track) {
      if (disposed) return;
      stopFrames?.();
      await attach(track);
      stopFrames = frameDriver(video, render);
    },
    stop() {
      disposed = true;
      stopFrames?.();
      stopFrames = null;
      release?.();
      release = null;
      try { video.pause(); } catch {}
      video.srcObject = null;
      outputStream?.getTracks().forEach((track) => track.stop());
      outputStream = null;
    },
  };
}
