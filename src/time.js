// Timestamps the way WhatsApp shows them, in the phone's own time zone: "10:35 pm" on bubbles; "Yesterday",
// a weekday or "07/11/2026" in the chat list; "Today" / "Yesterday" / "4 November 2026" between messages.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

// Whole calendar days between two moments in local time (DST-safe); 0 = same day, 1 = yesterday.
function daysAgo(date, now) {
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
}

const pad = (value) => String(value).padStart(2, '0');

export function formatMessageTime(timestamp) {
  const date = toDate(timestamp);
  if (!date) return '';
  const hours = date.getHours();
  return `${hours % 12 || 12}:${pad(date.getMinutes())} ${hours < 12 ? 'am' : 'pm'}`;
}

// Chat list: the time today, then "Yesterday", the weekday within a week, else the date.
export function formatChatListTime(timestamp, now = new Date()) {
  const date = toDate(timestamp);
  if (!date) return '';
  const days = daysAgo(date, now);
  if (days <= 0) return formatMessageTime(date);
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAYS[date.getDay()];
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

// The divider between days in a conversation.
export function formatMessageDate(timestamp, now = new Date()) {
  const date = toDate(timestamp);
  if (!date) return 'Unknown date';
  const days = daysAgo(date, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAYS[date.getDay()];
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// Groups messages by local calendar day.
export function localDateKey(timestamp) {
  const date = toDate(timestamp);
  return date ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` : '';
}

// Media viewer and call log, e.g. "Today, 2:05 am" or "4 March, 2:30 pm".
export function formatViewerTimestamp(timestamp, now = new Date()) {
  const date = toDate(timestamp);
  if (!date) return '';
  const days = daysAgo(date, now);
  let label;
  if (days <= 0) label = 'Today';
  else if (days === 1) label = 'Yesterday';
  else if (date.getFullYear() === now.getFullYear()) label = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
  else label = `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
  return `${label}, ${formatMessageTime(date)}`;
}
