// The status line under a contact's name: "online", "last seen today at 9:33 pm", or nothing when that
// person's privacy hides it (or the server has no time yet).
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 24 * 60 * 60 * 1000;

function clock(date) {
  const hours = date.getHours();
  return `${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'am' : 'pm'}`;
}

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

export function formatLastSeen(lastSeenAt, now = new Date()) {
  const seen = new Date(lastSeenAt);
  // Calendar days apart (DST-safe via rounding); a timestamp slightly in the future still counts as today.
  const days = Math.max(0, Math.round((startOfDay(now) - startOfDay(seen)) / DAY_MS));
  let day;
  if (days === 0) day = 'today';
  else if (days === 1) day = 'yesterday';
  else if (days < 7) day = WEEKDAYS[seen.getDay()];
  else if (seen.getFullYear() === now.getFullYear()) day = `${seen.getDate()} ${MONTHS[seen.getMonth()]}`;
  else day = `${seen.getDate()} ${MONTHS[seen.getMonth()]} ${seen.getFullYear()}`;
  return `last seen ${day} at ${clock(seen)}`;
}

export function presenceLine(presence, now = new Date()) {
  if (presence?.status === 'online') return 'online';
  if (presence?.status === 'offline' && Number.isFinite(presence.lastSeenAt)) return formatLastSeen(presence.lastSeenAt, now);
  return '';
}
