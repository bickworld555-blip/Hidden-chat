// Pure call-screen labels shared by the overlay and tests.

export function formatElapsed(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

// `answered` means both descriptions are exchanged; only the transport is left, so neither side
// should still read as calling or ringing.
export function getStatusLabel({ status, direction, mode, isOnline, answered, elapsed, group = false }) {
  const kind = `${group ? 'group ' : ''}${mode === 'video' ? 'video' : 'voice'} call`;
  if (status === 'connected') return formatElapsed(elapsed);
  if (status === 'reconnecting') return 'Reconnecting…';
  if (status === 'no-answer') return 'No answer';
  if (status === 'busy') return 'Busy';
  if (status === 'failed') return 'Call failed';
  if (status === 'ended') return 'Call ended';
  if (direction === 'incoming') {
    return status === 'idle' ? `Incoming ${kind}` : 'Connecting…';
  }
  if (answered) return 'Connecting…';
  if (status === 'ringing') return 'Ringing…';
  return isOnline ? 'Calling…' : 'Calling';
}
