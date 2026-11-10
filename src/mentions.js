// @mentions in group chats: "@username" in the text. The composer suggests members while an "@word" is being
// typed at the caret; bubbles highlight mentions of real members; a mention of you notifies even in a muted group.
const MENTION = /(^|[\s([{"'])@([a-z0-9_]{3,24})(?=$|[\s)\]}"'.,!?:;])/gi;

/** The "@prefix" being typed at the caret: { start, query } or null. */
export function activeMention(text, caret = text?.length ?? 0) {
  const before = (text ?? '').slice(0, caret);
  const match = /(^|\s)@([a-z0-9_]{0,24})$/i.exec(before);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2].toLowerCase() };
}

/** Members whose username or name starts with (or contains) the query, best matches first. */
export function mentionCandidates(members, query, { excludeId } = {}) {
  const q = (query ?? '').toLowerCase();
  return (members ?? [])
    .filter((member) => member?.username && member.id !== excludeId)
    .map((member) => {
      const username = member.username.toLowerCase();
      const name = (member.name ?? '').toLowerCase();
      const rank = username.startsWith(q) ? 0 : name.startsWith(q) ? 1 : username.includes(q) || name.includes(q) ? 2 : 3;
      return { member, rank };
    })
    .filter((item) => item.rank < 3)
    .sort((left, right) => left.rank - right.rank || left.member.username.localeCompare(right.member.username))
    .slice(0, 8)
    .map((item) => item.member);
}

/** Replaces the "@prefix" at `mention.start` with "@username " and returns { text, caret }. */
export function applyMention(text, mention, username, caret = text.length) {
  const inserted = `@${username} `;
  const next = text.slice(0, mention.start) + inserted + text.slice(caret);
  return { text: next, caret: mention.start + inserted.length };
}

/** Usernames mentioned in a message (lower case). */
export function mentionedUsernames(content) {
  if (typeof content !== 'string') return [];
  return [...content.matchAll(MENTION)].map((match) => match[2].toLowerCase());
}

export function mentionsUser(content, username) {
  return Boolean(username) && mentionedUsernames(content).includes(username.toLowerCase());
}

/** Splits text into plain parts and mention parts for known usernames: [{ text } | { mention, username }]. */
export function splitMentions(content, knownUsernames) {
  const known = knownUsernames instanceof Set ? knownUsernames : new Set((knownUsernames ?? []).map((name) => name.toLowerCase()));
  const parts = [];
  let index = 0;
  for (const match of content.matchAll(MENTION)) {
    const username = match[2].toLowerCase();
    if (!known.has(username)) continue;
    const start = match.index + match[1].length;
    if (start > index) parts.push({ text: content.slice(index, start) });
    parts.push({ mention: `@${match[2]}`, username });
    index = start + match[2].length + 1;
  }
  if (index < content.length) parts.push({ text: content.slice(index) });
  return parts;
}
