// Wording of a call card in the chat, as WhatsApp writes it.

// 45 secs · 1 min · 12 mins · 1 hr · 1 hr 5 mins
export function callDurationLabel(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total} sec${total === 1 ? '' : 's'}`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hr${hours === 1 ? '' : 's'}${rest ? ` ${rest} min${rest === 1 ? '' : 's'}` : ''}`;
}

// { title, detail, missed, answered, video } for a logged call: { duration, mode, status, direction }.
export function callCardView(call = {}, isOutgoing = false) {
  const video = call.mode === 'video';
  const kind = video ? 'video call' : 'voice call';
  const answered = call.status === 'completed' && Number(call.duration) > 0;
  const missed = !isOutgoing && !answered;
  if (missed) return { title: `Missed ${kind}`, detail: 'Tap to call back', missed, answered, video };
  const title = video ? 'Video call' : 'Voice call';
  return { title, detail: answered ? callDurationLabel(call.duration) : 'No answer', missed, answered, video };
}
