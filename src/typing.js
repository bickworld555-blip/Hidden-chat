// What a contact is doing right now in a one-to-one chat — "typing…" or "recording audio…" (as on WhatsApp).
// Sent as `presence:typing` {peerId, active, kind} over the realtime socket; never stored on the server or the device.
// The sender refreshes a running activity every REFRESH_MS; the receiver drops it after EXPIRES_MS without one, so a
// lost "stopped" (closed app, dropped connection) can't leave an indicator stuck on.

export const ACTIVITY_REFRESH_MS = 2500;
export const TYPING_IDLE_MS = 3000;
export const ACTIVITY_EXPIRES_MS = 6000;

/** The activity a `presence:typing` event announces: 'typing', 'recording', or null when it stopped. */
export function activityFromEvent(event) {
  if (!event?.active) return null;
  return event.kind === 'recording' ? 'recording' : 'typing';
}

export function activityLabel(kind) {
  if (kind === 'recording') return 'recording audio…';
  if (kind === 'typing') return 'typing…';
  return '';
}

/**
 * The sending side for one chat. `typed()` on each edit of the message box; `recording(true|false)` when a voice
 * note starts or ends; `stop()` when the chat closes or a message is sent. Sends at most one refresh per
 * ACTIVITY_REFRESH_MS, a "stopped" after TYPING_IDLE_MS without typing, and keeps a recording alive until it ends.
 */
export function createActivitySender(send, { peerId, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let kind = null;
  let sentAt = 0;
  let idleTimer = null;
  let refreshTimer = null;

  const announce = (next) => {
    kind = next;
    sentAt = now();
    send({ type: 'presence:typing', peerId, active: true, kind: next });
  };
  const clearTimers = () => {
    clearTimer(idleTimer);
    clearTimer(refreshTimer);
    idleTimer = null;
    refreshTimer = null;
  };
  const stop = () => {
    clearTimers();
    if (!kind) return;
    kind = null;
    send({ type: 'presence:typing', peerId, active: false });
  };
  const keepRecording = () => {
    refreshTimer = setTimer(() => {
      if (kind !== 'recording') return;
      announce('recording');
      keepRecording();
    }, ACTIVITY_REFRESH_MS);
  };

  return {
    typed() {
      if (!peerId || kind === 'recording') return;
      if (kind !== 'typing' || now() - sentAt >= ACTIVITY_REFRESH_MS) announce('typing');
      clearTimer(idleTimer);
      idleTimer = setTimer(stop, TYPING_IDLE_MS);
    },
    recording(on) {
      if (!peerId) return;
      if (!on) { if (kind === 'recording') stop(); return; }
      if (kind === 'recording') return;
      clearTimers();
      announce('recording');
      keepRecording();
    },
    stop,
    get kind() { return kind; },
  };
}
