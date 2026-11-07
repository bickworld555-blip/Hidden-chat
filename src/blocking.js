// Blocking is local to this device: each chat keeps its block periods so messages received while blocked stay
// hidden after an unblock, while messages from before or after a block are shown.
export function isBlocked(periods) {
  return Array.isArray(periods) && periods.length > 0 && !periods[periods.length - 1].to;
}

export function startBlock(periods, at) {
  return isBlocked(periods) ? periods : [...(periods ?? []), { from: at, to: null }];
}

export function endBlock(periods, at) {
  if (!isBlocked(periods)) return periods ?? [];
  return periods.map((period, index) => index === periods.length - 1 ? { ...period, to: at } : period);
}

export function hiddenByBlock(message, periods, userId) {
  if (!Array.isArray(periods) || !periods.length || message.senderId === userId) return false;
  const sent = message.timestamp;
  return periods.some((period) => sent >= period.from && (!period.to || sent < period.to));
}
