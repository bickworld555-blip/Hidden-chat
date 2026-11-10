import { memo } from 'react';
import { Lock, Minimize2, UserPlus } from 'lucide-react';
import { callAction, useCallSlice } from '../../callStore.js';
import { CallStatusLabel } from './CallTimer.jsx';

// Top of the call screen: minimize, the call's title and status line, add participant. Reads only the header
// slice (like WhatsApp's CallScreenHeaderView + CallHeaderStateHolder).
export default memo(function CallHeader() {
  const header = useCallSlice('header');
  const showButtons = !header.incomingRinging && !header.terminal;
  return (
    <header className="wa-call-header">
      {showButtons ? (
        <button type="button" className="wa-call-circle-btn" onClick={() => callAction('minimize')} aria-label="Minimize call" title="Minimize call">
          <Minimize2 size={20} />
        </button>
      ) : <span className="wa-call-header-spacer" />}

      <div className="wa-call-header-info">
        <h1 className="wa-call-peer-title">{header.title}</h1>
        <span className="wa-call-status-badge">{!header.terminal && <Lock size={11} className="wa-call-lock" aria-label="End-to-end encrypted" />}<CallStatusLabel /></span>
      </div>

      {showButtons ? (
        <button
          type="button"
          className="wa-call-circle-btn"
          onClick={() => callAction('openAddParticipant')}
          disabled={!header.canAdd}
          title={header.addTitle}
          aria-label="Add participant"
        >
          <UserPlus size={20} />
        </button>
      ) : <span className="wa-call-header-spacer" />}
    </header>
  );
});
