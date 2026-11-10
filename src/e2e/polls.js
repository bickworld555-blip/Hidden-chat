// End-to-end encrypted poll votes. A vote is "vote:[option indexes]" sealed like a message: for the chat's devices
// (direct) or with the group's sender key. The server stores one sealed vote per voter and cannot count them;
// every device opens the votes and counts, ignoring anything that does not fit the poll.
import { apiFetch } from '../api.js';
import { e2eActive, isEnvelope, openContent, sendDirectContent, sendGroupContent } from './client.js';

const VOTE_PREFIX = 'vote:';

/** The options a vote names, if they fit the poll (in range; one option unless it allows several). */
export function parseVote(content, optionCount, multiple) {
  if (typeof content !== 'string' || !content.startsWith(VOTE_PREFIX)) return null;
  let options;
  try {
    options = JSON.parse(content.slice(VOTE_PREFIX.length));
  } catch {
    return null;
  }
  if (!Array.isArray(options)) return null;
  const unique = [...new Set(options)];
  if (unique.some((option) => !Number.isInteger(option) || option < 0 || option >= optionCount)) return null;
  if (!multiple && unique.length > 1) return null;
  return unique;
}

/**
 * Plain votes ({ [option]: [userId] }) plus opened sealed ones → one tally map. `context` is { groupId } for a
 * group poll, or {} for a direct chat (the voter's own sealed vote is opened from this device's memory).
 */
export async function combineVotes({ votes = {}, sealedVotes = [] }, poll, context = {}) {
  const combined = {};
  for (const [option, voters] of Object.entries(votes ?? {})) combined[option] = [...voters];
  for (const { userId, sealed } of sealedVotes ?? []) {
    if (!isEnvelope(sealed)) continue;
    const opened = await openContent(sealed, { senderId: userId, ...(context.groupId ? { groupId: context.groupId } : {}) });
    const options = parseVote(opened.content, poll.options.length, poll.multiple === true);
    if (!options) continue;
    for (const option of options) {
      combined[option] = (combined[option] ?? []).filter((id) => id !== userId);
      combined[option].push(userId);
    }
  }
  return combined;
}

async function putJson(sessionToken, path, body) {
  const response = await apiFetch(path, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${sessionToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error ?? 'Your vote was not saved.');
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

/**
 * Casts this user's choice (empty list withdraws it). Sealed when encryption is on for the chat ({ peerId } or
 * { groupId }); otherwise the plain vote. Resolves the server's { votes, sealedVotes }.
 */
export async function castVote(sessionToken, messageId, options, context) {
  const path = `/api/v1/polls/${encodeURIComponent(messageId)}`;
  if (!options.length) return putJson(sessionToken, `${path}/sealed-vote`, { sealed: null });
  const content = VOTE_PREFIX + JSON.stringify(options);
  if (e2eActive() && context?.groupId) {
    return sendGroupContent(context.groupId, content, async (sealed) => (isEnvelope(sealed)
      ? putJson(sessionToken, `${path}/sealed-vote`, { sealed })
      : putJson(sessionToken, `${path}/vote`, { options })));
  }
  if (e2eActive() && context?.peerId) {
    return sendDirectContent(context.peerId, content, async (sealed) => (isEnvelope(sealed)
      ? putJson(sessionToken, `${path}/sealed-vote`, { sealed })
      : putJson(sessionToken, `${path}/vote`, { options })));
  }
  return putJson(sessionToken, `${path}/vote`, { options });
}

