// What a contact is doing right now in a chat or a group — "typing…" or "recording audio…" (as on WhatsApp).
// Sent as `presence:typing` {peerId | groupId, active, kind} over the realtime socket (a group's members also get the
// sender's name); never stored on the server or the device.
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
export function createActivitySender(send, { peerId, groupId, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const target = groupId ? { groupId } : peerId ? { peerId } : null;
  let kind = null;
  let sentAt = 0;
  let idleTimer = null;
  let refreshTimer = null;

  const announce = (next) => {
    kind = next;
    sentAt = now();
    send({ type: 'presence:typing', ...target, active: true, kind: next });
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
    send({ type: 'presence:typing', ...target, active: false });
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
      if (!target || kind === 'recording') return;
      if (kind !== 'typing' || now() - sentAt >= ACTIVITY_REFRESH_MS) announce('typing');
      clearTimer(idleTimer);
      idleTimer = setTimer(stop, TYPING_IDLE_MS);
    },
    recording(on) {
      if (!target) return;
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

/**
 * The line a group shows for who is busy in it, as on WhatsApp: "Ava is typing…", "Ava is recording audio…",
 * "Ava and Ben are typing…", "3 people are typing…". `people` is [{ name, kind }], in the order they started.
 */
export function groupActivityLabel(people) {
  const list = (people ?? []).filter((person) => person?.kind);
  if (list.length === 0) return '';
  if (list.length === 1) return `${list[0].name || 'Someone'} is ${activityLabel(list[0].kind)}`;
  const verb = list.every((person) => person.kind === 'recording') ? 'recording audio…' : 'typing…';
  if (list.length === 2) return `${list[0].name || 'Someone'} and ${list[1].name || 'someone'} are ${verb}`;
  return `${list.length} people are ${verb}`;
}

/**
 * The people busy in a group, named as this device knows them: `nameFor(userId)` (e.g. a saved contact's name) first,
 * else the name the server sent with the event.
 */
export function groupActivityPeople(entries, nameFor = () => '') {
  return Object.entries(entries ?? {}).map(([userId, entry]) => ({ userId, kind: entry?.kind, name: nameFor(userId) || entry?.name || '' }));
}
