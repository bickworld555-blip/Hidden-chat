import { memo } from 'react';
import { Mic, MicOff, MonitorUp, MoreHorizontal, PhoneOff, ScanFace, Video, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { callAction, useCallSlice } from '../../callStore.js';

// The bottom controls (like WhatsApp's CallControlCard): a floating dock in video calls, a two-row card in voice
// calls. Reads only the controls slice; every button goes back to the call through callAction().
export default memo(function ControlCard() {
  const c = useCallSlice('controls');
  if (c.incomingRinging) return null;
  const connectedish = c.status === 'connected' || c.status === 'reconnecting';
  const speakerIcon = (size) => (c.speakerOn || c.nativeRouting ? <Volume2 size={size} /> : <VolumeX size={size} />);

  if (c.mode === 'video') {
    return (
      <footer className="wa-video-bottom-dock">
        <button type="button" className={`wa-dock-btn ${c.moreOpen ? 'active' : ''}`} onClick={() => callAction('toggleMore')} title="More options" aria-label="More options" aria-expanded={c.moreOpen}>
          <MoreHorizontal size={22} />
        </button>
        <button type="button" className={`wa-dock-btn ${c.cameraOff ? 'active' : ''}`} onClick={() => callAction('toggleCamera')} title={c.cameraOff ? 'Turn camera on' : 'Turn camera off'} aria-label={c.cameraOff ? 'Turn camera on' : 'Turn camera off'}>
          {c.cameraOff ? <VideoOff size={22} /> : <Video size={22} />}
        </button>
        <button
          type="button"
          className={`wa-dock-btn ${c.nativeRouting ? (c.speakerOn ? 'active' : '') : (!c.speakerOn ? 'active' : '')}`}
          onClick={() => callAction('toggleSpeaker')}
          title={c.speakerLabel}
          aria-label={c.speakerLabel}
          aria-pressed={c.speakerOn}
        >
          {speakerIcon(22)}
        </button>
        <button type="button" className={`wa-dock-btn ${c.muted ? 'active' : ''}`} onClick={() => callAction('toggleMute')} title={c.muted ? 'Unmute microphone' : 'Mute microphone'} aria-label={c.muted ? 'Unmute microphone' : 'Mute microphone'}>
          {c.muted ? <MicOff size={22} /> : <Mic size={22} />}
        </button>
        <button type="button" className="wa-dock-btn end-call" onClick={() => callAction('endCall')} title={c.terminal ? 'Close' : 'End call'} aria-label={c.terminal ? 'Close' : 'End call'}>
          <PhoneOff size={22} />
        </button>
      </footer>
    );
  }

  return (
    <footer className="wa-audio-bottom-sheet">
      <div className="wa-audio-actions-grid">
        <button type="button" className={`wa-action-cell ${c.speakerOn ? 'selected' : ''}`} onClick={() => callAction('toggleSpeaker')} aria-label={c.speakerLabel} aria-pressed={c.speakerOn}>
          <span className="wa-action-bubble">{speakerIcon(24)}</span>
          <span className="wa-action-name">Speaker</span>
        </button>
        <button
          type="button"
          className={`wa-action-cell ${c.videoRequest === 'outgoing' ? 'selected' : ''}`}
          onClick={() => callAction(c.videoRequest === 'outgoing' ? 'cancelVideoRequest' : 'requestVideo')}
          disabled={!connectedish}
          title={c.status === 'connected' ? 'Ask to switch to video' : 'Available once connected'}
        >
          <span className="wa-action-bubble"><Video size={24} /></span>
          <span className="wa-action-name">Video</span>
        </button>
        <button type="button" className={`wa-action-cell ${c.muted ? 'selected' : ''}`} onClick={() => callAction('toggleMute')}>
          <span className="wa-action-bubble">{c.muted ? <MicOff size={24} /> : <Mic size={24} />}</span>
          <span className="wa-action-name">Mute</span>
        </button>
        <button type="button" className={`wa-action-cell ${c.moreOpen ? 'selected' : ''}`} onClick={() => callAction('toggleMore')} title="More options" aria-expanded={c.moreOpen}>
          <span className="wa-action-bubble"><MoreHorizontal size={24} /></span>
          <span className="wa-action-name">More</span>
        </button>
        <button
          type="button"
          className={`wa-action-cell ${c.screenSharing ? 'selected' : ''}`}
          title={c.canShareScreen ? (c.screenSharing ? 'Stop sharing screen' : 'Share your screen') : 'Screen sharing is not available in this browser'}
          onClick={() => callAction('toggleScreenShare')}
          disabled={!c.canShareScreen || c.status !== 'connected'}
        >
          <span className="wa-action-bubble"><MonitorUp size={22} /></span>
          <span className="wa-action-name">{c.screenSharing ? 'Stop share' : 'Share screen'}</span>
        </button>
        <button type="button" className="wa-action-cell danger" onClick={() => callAction('endCall')}>
          <span className="wa-action-bubble end-btn"><PhoneOff size={24} /></span>
          <span className="wa-action-name">End</span>
        </button>
      </div>
    </footer>
  );
});
