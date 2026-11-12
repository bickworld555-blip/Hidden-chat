// Contact book vs chat list. A server link carries two flags: `saved` (the person is in the contact book) and
// `hidden` (the thread was deleted from the chat list). The chat list shows unhidden links; the contact picker
// shows saved links, including those whose thread is hidden. The store owns this split; views only read it.

export function isSavedContact(link) {
  return link?.saved === true;
}

export function splitLinks(links) {
  const list = Array.isArray(links) ? links.filter((link) => link?.id) : [];
  const chats = [];
  const hiddenContacts = [];
  for (const { hidden, ...link } of list) {
    if (!hidden) chats.push(link);
    else if (isSavedContact(link)) hiddenContacts.push(link);
  }
  return { chats, hiddenContacts };
}

const byName = (left, right) => String(left.name ?? left.username ?? '').localeCompare(String(right.name ?? right.username ?? ''));

// Everyone in the contact book, whether or not their thread is currently in the chat list.
export function savedContacts(chats, hiddenContacts = [], { userId } = {}) {
  const seen = new Set();
  const out = [];
  for (const link of [...(chats ?? []), ...(hiddenContacts ?? [])]) {
    if (!link?.id || link.id === userId || link.group || link.deleted || !isSavedContact(link) || seen.has(link.id)) continue;
    seen.add(link.id);
    out.push(link);
  }
  return out.sort(byName);
}

// Threads with people who are not in the contact book (direct chats started from a search).
export function unsavedThreads(chats, { userId } = {}) {
  return (chats ?? []).filter((link) => link?.id && link.id !== userId && !link.group && !link.deleted && !isSavedContact(link)).sort(byName);
}

// Matches a person against a free-text query by display name or @handle.
export function matchesPerson(person, query) {
  const needle = String(query ?? '').trim().toLowerCase().replace(/^@/, '');
  if (!needle) return true;
  return String(person?.name ?? '').toLowerCase().includes(needle) || String(person?.username ?? '').toLowerCase().includes(needle);
}

// Suggestion rows for the "Enter @username" box: known people first, then server results not already known.
export function mergeSuggestions(known, remote, query) {
  const needle = String(query ?? '').trim();
  if (!needle) return [];
  const seen = new Set();
  const out = [];
  for (const person of known ?? []) {
    if (person?.id && matchesPerson(person, needle) && !seen.has(person.id)) { seen.add(person.id); out.push({ ...person, known: true }); }
  }
  for (const person of remote ?? []) {
    if (person?.id && !seen.has(person.id)) { seen.add(person.id); out.push({ ...person, known: false }); }
  }
  return out.slice(0, 8);
}

// The exact-handle match for the Add button, if the typed handle names someone in the suggestions.
export function exactHandleMatch(suggestions, query) {
  const handle = String(query ?? '').trim().toLowerCase().replace(/^@/, '');
  if (!handle) return null;
  return (suggestions ?? []).find((person) => String(person.username ?? '').toLowerCase() === handle) ?? null;
}
