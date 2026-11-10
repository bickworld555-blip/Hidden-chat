// In-call notices one at a time, by priority, like WhatsApp's ActionFeedbackPriorityQueue: "Inviting Ava…",
// "Ava declined", "You are offline" never overwrite or flicker over each other. Pure state transitions, so the
// call store (src/callStore.js) and tests share them.

export const NOTICE_PRIORITY = Object.freeze({ LOW: 0, NORMAL: 1, HIGH: 2 });
export const NOTICE_MS = 3500;
const MAX_QUEUED = 6;

export const EMPTY_NOTICES = Object.freeze({ current: null, queue: Object.freeze([]) });

let sequence = 0;

/**
 * Adds a notice. A notice with the same `key` replaces the queued one (an update, not a second notice); with
 * nothing showing it shows at once; a higher priority than the one showing goes first in the queue.
 */
export function pushNotice(state, text, { priority = NOTICE_PRIORITY.NORMAL, key = text, durationMs = NOTICE_MS } = {}) {
  if (!text) return state;
  sequence += 1;
  const notice = { id: sequence, text, priority, key, durationMs };
  if (state.current?.key === key) return { ...state, current: { ...notice, id: state.current.id } };
  const queue = state.queue.filter((item) => item.key !== key);
  if (!state.current) return { current: notice, queue };
  const next = [...queue, notice].sort((a, b) => b.priority - a.priority || a.id - b.id).slice(0, MAX_QUEUED);
  return { ...state, queue: next };
}

/** The showing notice is done (its time is up, or it was tapped away): the next one shows. */
export function nextNotice(state, id = state.current?.id) {
  if (!state.current || state.current.id !== id) return state;
  const [current = null, ...queue] = state.queue;
  return { current, queue };
}
