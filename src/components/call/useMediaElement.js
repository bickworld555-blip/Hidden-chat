import { useEffect } from 'react';

// How often a call's media element is checked, and how many checks with no new frame (while its video track is live
// and sending) count as a frozen picture.
export const VIDEO_STALL_CHECK_MS = 1000;
export const VIDEO_STALL_CHECKS = 2;

/** Whether a bound video should be moving: a live, enabled, unmuted video track, on a visible page. */
export const videoShouldPlay = (stream, visible = true) => visible
  && Boolean(stream?.getVideoTracks().some((track) => track.readyState === 'live' && track.enabled && !track.muted));

/** Whether a bound element should be playing at all: any live track in its stream. */
export const mediaShouldPlay = (stream) => Boolean(stream?.getTracks().some((track) => track.readyState === 'live'));

// Restarting the phone's call audio output: every call media element lets go of its stream at the same moment and takes
// it back RESTART_GAP_MS later. WebView plays all of a call's incoming voice through one shared output; once Android
// has cut that output (Telecom set the audio mode back to normal as the previous call ended), re-attaching one
// <audio> element is not enough: the output is only recreated when no element holds the voice any more. Measured live
// on the S23: nothing played for over a minute; after this, both people were heard at once (4 s of voice in 4 s).
export const RESTART_GAP_MS = 600;
export const RESTART_MIN_INTERVAL_MS = 5000;
const RESTART_EVENT = 'hm:call-media-restart';
let lastRestart = -Infinity;
/** Restarts the call audio output (see above), at most once per RESTART_MIN_INTERVAL_MS; true when it did. */
export function restartCallMediaOutput(now = Date.now()) {
  if (typeof window === 'undefined' || now - lastRestart < RESTART_MIN_INTERVAL_MS) return false;
  lastRestart = now;
  window.dispatchEvent(new Event(RESTART_EVENT));
  return true;
}

// Binds a MediaStream to a <video>/<audio> element and keeps it bound as tracks come and go, and keeps it playing.
//
// Both faults below were measured live on the S23 (Android WebView, DevTools):
// - Audio: about two seconds into a call the <audio> element stopped with MEDIA_ERR_DECODE (error code 3, paused)
//   while the other person's audio kept arriving (packets in, no samples played): that phone heard nothing, the
//   other person was heard fine ("one hears, the other does not"). A failed or paused element is re-attached and
//   played again at the next check.
// - Video: at each change of resolution the <video> stopped drawing (its time froze) while frames kept arriving.
//   One whose time has not moved for VIDEO_STALL_CHECKS checks while its track is live and sending is re-attached.
// Re-attaching (a new MediaStream over the same tracks) brought both back at once.
export function useMediaElement(ref, stream, enabled = true) {
  const tracksKey = stream?.getTracks().map((track) => track.id).join('|') ?? '';
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return undefined;
    let boundStream = null;
    const bind = () => {
      boundStream = stream ? new MediaStream(stream.getTracks()) : null;
      element.srcObject = boundStream;
      if (boundStream) element.play?.().catch((error) => console.warn('Call media playback failed:', error));
    };
    bind();
    stream?.addEventListener('addtrack', bind);
    stream?.addEventListener('removetrack', bind);
    // A playback error is answered at once (the next check would leave a second of silence or a frozen picture).
    let retry = null;
    const onError = () => { clearTimeout(retry); retry = setTimeout(() => { if (mediaShouldPlay(boundStream)) bind(); }, 250); };
    element.addEventListener('error', onError);
    let restart = null;
    const onRestart = () => {
      if (!boundStream) return;
      clearTimeout(restart);
      boundStream = null;
      element.srcObject = null;
      restart = setTimeout(bind, RESTART_GAP_MS);
    };
    window.addEventListener(RESTART_EVENT, onRestart);
    let watchdog = null;
    if (stream) {
      const isVideo = element.tagName === 'VIDEO';
      let lastTime = -1;
      let still = 0;
      watchdog = setInterval(() => {
        if (!mediaShouldPlay(boundStream)) { still = 0; return; }
        // Stopped by an error, or paused although the call goes on: back on.
        if (element.error) { bind(); still = 0; return; }
        if (element.paused) { element.play?.().catch(() => bind()); still = 0; return; }
        if (!isVideo) return;
        if (!videoShouldPlay(boundStream, document.visibilityState !== 'hidden')) { still = 0; lastTime = element.currentTime; return; }
        if (element.currentTime === lastTime) {
          still += 1;
          if (still >= VIDEO_STALL_CHECKS) { still = 0; bind(); }
        } else {
          still = 0;
        }
        lastTime = element.currentTime;
      }, VIDEO_STALL_CHECK_MS);
    }
    return () => {
      clearInterval(watchdog);
      clearTimeout(retry);
      clearTimeout(restart);
      window.removeEventListener(RESTART_EVENT, onRestart);
      element.removeEventListener('error', onError);
      stream?.removeEventListener('addtrack', bind);
      stream?.removeEventListener('removetrack', bind);
      if (element.srcObject === boundStream) element.srcObject = null;
    };
  }, [ref, stream, enabled, tracksKey]);
}
