import { memo } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { callAction, useCallSlice } from '../../callStore.js';

// Decline / Accept while a call rings in the app. Reads only whether it is ringing.
export default memo(function IncomingCallSheet() {
  const ringing = useCallSlice('controls').incomingRinging;
  if (!ringing) return null;
  return (
    <div className="wa-incoming-call-actions">
      <button type="button" className="wa-incoming-btn decline" onClick={() => callAction('endCall')}>
        <span className="wa-incoming-icon"><PhoneOff size={28} /></span>
        <span className="wa-incoming-label">Decline</span>
      </button>
      <button type="button" className="wa-incoming-btn accept" onClick={() => callAction('acceptCall')}>
        <span className="wa-incoming-icon"><Phone size={28} /></span>
        <span className="wa-incoming-label">Accept</span>
      </button>
    </div>
  );
});
