// Long-chat rendering (ChatWindow): the newest RENDER_WINDOW messages, RENDER_MARGIN more around a jump target,
// and LOAD_OLDER_STEP more each time the user scrolls near the top.
export const RENDER_WINDOW = 150;
export const LOAD_OLDER_STEP = 100;
export const RENDER_MARGIN = 20;

/** The newest `count` messages (the same array when everything fits, so memoized rows are reused). */
export function windowedMessages(messages, count) {
  return messages.length > count ? messages.slice(-count) : messages;
}

/** How many newest messages must be rendered so `messageId` is on screen with a margin; 0 when unknown. */
export function renderCountFor(messages, messageId, margin = RENDER_MARGIN) {
  const index = messages.findIndex((message) => message?.id === messageId);
  return index < 0 ? 0 : messages.length - index + margin;
}
