// Disappearing-message timers offered in Contact info. The server accepts only these durations.
export const DISAPPEARING_OPTIONS = Object.freeze([
  { seconds: 24 * 60 * 60, label: '24 hours' },
  { seconds: 7 * 24 * 60 * 60, label: '7 days' },
  { seconds: 90 * 24 * 60 * 60, label: '90 days' },
  { seconds: 0, label: 'Off' },
]);

export function isDisappearingDuration(seconds) {
  return DISAPPEARING_OPTIONS.some((option) => option.seconds === seconds);
}

export function disappearingLabel(seconds) {
  return DISAPPEARING_OPTIONS.find((option) => option.seconds === seconds)?.label ?? 'Off';
}
