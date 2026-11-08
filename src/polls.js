// Poll messages: "poll:" + JSON {question, options[], multiple}. Votes live on the server per option and
// arrive as { [optionIndex]: [userId, …] }.
export const MAX_POLL_OPTIONS = 12;
export const MAX_POLL_TEXT = 200;

const clean = (text) => String(text ?? '').trim().slice(0, MAX_POLL_TEXT);

export function encodePoll({ question, options, multiple = false }) {
  const title = clean(question);
  const seen = new Set();
  const choices = (Array.isArray(options) ? options : []).map(clean).filter((option) => {
    if (!option || seen.has(option.toLowerCase())) return false;
    seen.add(option.toLowerCase());
    return true;
  }).slice(0, MAX_POLL_OPTIONS);
  if (!title || choices.length < 2) return null;
  return `poll:${JSON.stringify({ question: title, options: choices, multiple: Boolean(multiple) })}`;
}

export function parsePollContent(content) {
  if (typeof content !== 'string' || !content.startsWith('poll:')) return null;
  try {
    const poll = JSON.parse(content.slice(5));
    if (typeof poll?.question !== 'string' || !Array.isArray(poll.options) || poll.options.length < 2) return null;
    return { question: poll.question, options: poll.options.map(String), multiple: poll.multiple === true };
  } catch {
    return null;
  }
}

export function pollSummary(content) {
  const poll = parsePollContent(content);
  return poll ? `📊 Poll: ${poll.question}` : null;
}

export function tallyPoll(votes, optionCount, myId) {
  const counts = Array.from({ length: optionCount }, (_, index) => votes?.[index]?.length ?? 0);
  const voters = new Set(Object.values(votes ?? {}).flat());
  return {
    counts,
    total: counts.reduce((sum, count) => sum + count, 0),
    voters: voters.size,
    mine: counts.map((_, index) => index).filter((index) => votes?.[index]?.includes(myId)),
    leader: Math.max(0, ...counts),
  };
}
