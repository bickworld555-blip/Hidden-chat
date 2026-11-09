// The status line under a contact's name: "online", "last seen today at 9:33 pm", "last seen 2 weeks ago",
// or nothing when that person's privacy hides it (or the server has no time yet).
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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
  // Within a week: the day and time. Older: how long ago, in weeks, then months.
  if (days < 7) {
    const day = days === 0 ? 'today' : days === 1 ? 'yesterday' : WEEKDAYS[seen.getDay()];
    return `last seen ${day} at ${clock(seen)}`;
  }
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return `last seen ${weeks} week${weeks === 1 ? '' : 's'} ago`;
  }
  if (days < 365) {
    const months = Math.max(1, Math.floor(days / 30));
    return `last seen ${months} month${months === 1 ? '' : 's'} ago`;
  }
  return 'last seen over a year ago';
}

export function presenceLine(presence, now = new Date()) {
  if (presence?.status === 'online') return 'online';
  if (presence?.status === 'offline' && Number.isFinite(presence.lastSeenAt)) return formatLastSeen(presence.lastSeenAt, now);
  return '';
}
