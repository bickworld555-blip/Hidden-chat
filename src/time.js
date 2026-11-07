const timeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
});

function utcDayKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function formatMessageTime(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  return `${timeFormatter.format(date)} GMT`;
}

export function formatMessageDate(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return 'Unknown date';
  const currentDay = utcDayKey(now);
  const messageDay = utcDayKey(date);
  const previous = new Date(now);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const previousDay = utcDayKey(previous);
  const fullDate = dateFormatter.format(date);
  if (messageDay === currentDay) return `Today · ${fullDate} GMT`;
  if (messageDay === previousDay) return `Yesterday · ${fullDate} GMT`;
  return `${fullDate} GMT`;
}

export function utcDateKey(timestamp) {
  return utcDayKey(timestamp);
}

const shortDateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' });
const longDateFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });

// Media viewer subtitle, e.g. "Today, 2:05 AM GMT" or "March 4, 2:05 AM GMT".
export function formatViewerTimestamp(timestamp, now = new Date()) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const day = utcDayKey(date);
  const previous = new Date(now);
  previous.setUTCDate(previous.getUTCDate() - 1);
  let label;
  if (day === utcDayKey(now)) label = 'Today';
  else if (day === utcDayKey(previous)) label = 'Yesterday';
  else if (date.getUTCFullYear() === now.getUTCFullYear()) label = shortDateFormatter.format(date);
  else label = longDateFormatter.format(date);
  return `${label}, ${formatMessageTime(date)}`;
}