import { memo } from 'react';
import { Mic, MicOff, MoreHorizontal, PhoneOff, Video, VideoOff, Volume2, VolumeX } from 'lucide-react';
import { callAction, useCallSlice } from '../../callStore.js';

// The bottom controls: one rounded dock for voice and video calls alike — More, camera (video) or "switch to
// video" (voice), speaker, mute, end. Screen sharing, reactions and the rest live in More (CallMoreSheet.jsx).
// Reads only the controls slice; every button goes back to the call through callAction().
export default memo(function ControlCard() {
  const c = useCallSlice('controls');
  if (c.incomingRinging) return null;
  const connectedish = c.status === 'connected' || c.status === 'reconnecting';
  const speakerIcon = (size) => (c.speakerOn || c.nativeRouting ? <Volume2 size={size} /> : <VolumeX size={size} />);
  const video = c.mode === 'video';
  const askingVideo = c.videoRequest === 'outgoing';

  return (
    <footer className={`wa-video-bottom-dock${video ? '' : ' is-voice'}`}>
      <button type="button" className={`wa-dock-btn ${c.moreOpen ? 'active' : ''}`} onClick={() => callAction('toggleMore')} title="More options" aria-label="More options" aria-expanded={c.moreOpen}>
        <MoreHorizontal size={22} />
      </button>
      {video ? (
        <button type="button" className={`wa-dock-btn ${c.cameraOff ? 'active' : ''}`} onClick={() => callAction('toggleCamera')} title={c.cameraOff ? 'Turn camera on' : 'Turn camera off'} aria-label={c.cameraOff ? 'Turn camera on' : 'Turn camera off'}>
          {c.cameraOff ? <VideoOff size={22} /> : <Video size={22} />}
        </button>
      ) : (
        <button type="button" className={`wa-dock-btn ${askingVideo ? 'active' : ''}`} onClick={() => callAction(askingVideo ? 'cancelVideoRequest' : 'requestVideo')}
          disabled={!connectedish} title={connectedish ? (askingVideo ? 'Cancel the video request' : 'Ask to switch to video') : 'Available once connected'}
          aria-label={askingVideo ? 'Cancel the video request' : 'Switch to video'}>
          <Video size={22} />
        </button>
      )}
      <button
        type="button"
        className={`wa-dock-btn ${c.nativeRouting ? (c.speakerOn ? 'active' : '') : (video ? (!c.speakerOn ? 'active' : '') : (c.speakerOn ? 'active' : ''))}`}
        onClick={() => callAction('toggleSpeaker')}
        title={c.speakerLabel}
        aria-label={c.speakerLabel}
        aria-pressed={c.speakerOn}
      >
        {speakerIcon(22)}
      </button>
      <button type="button" className={`wa-dock-btn ${c.muted ? 'active' : ''}`} onClick={() => callAction('toggleMute')} title={c.muted ? 'Unmute microphone' : 'Mute microphone'} aria-label={c.muted ? 'Unmute microphone' : 'Mute microphone'} aria-pressed={c.muted}>
        {c.muted ? <MicOff size={22} /> : <Mic size={22} />}
      </button>
      <button type="button" className="wa-dock-btn end-call" onClick={() => callAction('endCall')} title={c.terminal ? 'Close' : 'End call'} aria-label={c.terminal ? 'Close' : 'End call'}>
        <PhoneOff size={22} />
      </button>
    </footer>
  );
});
