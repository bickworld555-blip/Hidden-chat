import { useEffect } from 'react';

// How often a call's <video> is checked, and how many checks with no new frame (while its track is live and
// sending) count as frozen.
export const VIDEO_STALL_CHECK_MS = 1000;
export const VIDEO_STALL_CHECKS = 2;

/** Whether a bound video should be moving: a live, enabled, unmuted video track, on a visible page. */
export const videoShouldPlay = (stream, visible = true) => visible
  && Boolean(stream?.getVideoTracks().some((track) => track.readyState === 'live' && track.enabled && !track.muted));

// Binds a MediaStream to a <video>/<audio> element and keeps it bound as tracks come and go.
//
// Video stall watchdog. Seen live on the S23 (Android WebView): when the picture's resolution changed mid-call
// (the network adapting 360 → 540 → 144 → 720, and the sender's adaptation reaching the shared camera track), the
// <video> stopped drawing: its time froze while frames kept arriving at 15 fps, for both the other person's picture
// and one's own. Re-attaching the stream brought it back at once. So a video whose time has not moved for
// VIDEO_STALL_CHECKS checks while its track is live is re-attached (and a paused one played again).
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
    let watchdog = null;
    if (element.tagName === 'VIDEO' && stream) {
      let lastTime = -1;
      let still = 0;
      watchdog = setInterval(() => {
        if (!videoShouldPlay(boundStream, document.visibilityState !== 'hidden')) { still = 0; lastTime = element.currentTime; return; }
        if (element.paused) { element.play?.().catch(() => {}); still = 0; return; }
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
      stream?.removeEventListener('addtrack', bind);
      stream?.removeEventListener('removetrack', bind);
      if (element.srcObject === boundStream) element.srcObject = null;
    };
  }, [ref, stream, enabled, tracksKey]);
}
