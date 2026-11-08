// Event messages: "event:" + JSON {title, startsAt (ISO), location?, description?}, with an "Add to calendar"
// .ics file (RFC 5545) generated on the device.
const clip = (value, max) => String(value ?? '').trim().slice(0, max);

// `startsAt` is what a datetime-local input gives ("2026-11-20T19:30", device time) or any parseable date.
export function encodeEvent({ title, startsAt, location, description }) {
  const name = clip(title, 120);
  const start = new Date(startsAt);
  if (!name || Number.isNaN(start.getTime())) return null;
  const event = { title: name, startsAt: start.toISOString() };
  if (clip(location, 200)) event.location = clip(location, 200);
  if (clip(description, 1000)) event.description = clip(description, 1000);
  return `event:${JSON.stringify(event)}`;
}

export function parseEventContent(content) {
  if (typeof content !== 'string' || !content.startsWith('event:')) return null;
  try {
    const event = JSON.parse(content.slice(6));
    if (typeof event?.title !== 'string' || Number.isNaN(new Date(event.startsAt).getTime())) return null;
    return { title: event.title, startsAt: event.startsAt, location: event.location ?? '', description: event.description ?? '' };
  } catch {
    return null;
  }
}

export function eventSummary(content) {
  const event = parseEventContent(content);
  return event ? `📅 ${event.title}` : null;
}

export function formatEventTime(startsAt, locale) {
  return new Date(startsAt).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const icsText = (value) => String(value).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Lines longer than 75 octets continue on the next line after a single space.
function fold(line) {
  const parts = [];
  let rest = line;
  while (new TextEncoder().encode(rest).length > 75) {
    let cut = 75;
    while (new TextEncoder().encode(rest.slice(0, cut)).length > 75) cut -= 1;
    parts.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  parts.push(rest);
  return parts.join('\r\n');
}

export function eventCalendarFile({ id, title, startsAt, location, description }, now = new Date()) {
  const start = new Date(startsAt);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hidden Messenger//Events//EN',
    'BEGIN:VEVENT',
    `UID:${id}@hiddenmessenger.com`,
    `DTSTAMP:${icsTime(now)}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsText(title)}`,
    ...(location ? [`LOCATION:${icsText(location)}`] : []),
    ...(description ? [`DESCRIPTION:${icsText(description)}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
