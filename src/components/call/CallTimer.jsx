import { memo, useEffect, useState } from 'react';
import { getStatusLabel } from '../../callStatus.js';
import { useCallSlice } from '../../callStore.js';

// The call's status line ("Calling…", "Ringing…", "02:41", "Call ended"). It is the only part of the call screen
// that changes every second, and it ticks on its own: while connected it keeps a private once-a-second clock, so
// the rest of the call screen (video, tiles, controls) never redraws for the timer.
export const CallStatusLabel = memo(function CallStatusLabel() {
  const header = useCallSlice('header');
  const live = header.status === 'connected' || header.status === 'reconnecting';
  const startedAt = header.connectedAt || 0;
  const [elapsed, setElapsed] = useState(() => (live && startedAt ? (Date.now() - startedAt) / 1000 : 0));

  useEffect(() => {
    if (!live) return undefined;
    const from = startedAt || Date.now();
    const tick = () => setElapsed((Date.now() - from) / 1000);
    tick();
    // Aligned to the next whole second so the digits change exactly on the second.
    let timer = setTimeout(function next() {
      tick();
      timer = setTimeout(next, 1000 - ((Date.now() - from) % 1000));
    }, 1000 - ((Date.now() - from) % 1000));
    return () => clearTimeout(timer);
  }, [live, startedAt]);

  return getStatusLabel({ status: header.status, direction: header.direction, mode: header.mode, isOnline: header.isOnline, answered: header.answered, elapsed, group: header.group, networkQuality: header.networkQuality });
});
