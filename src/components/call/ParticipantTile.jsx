import { memo, useEffect, useRef } from 'react';
import Avatar from '../Avatar.jsx';
import { TERMINAL_STATUSES } from '../../callEngine.js';
import SpeakingIndicator from './SpeakingIndicator.jsx';
import { useMediaElement } from './useMediaElement.js';

// One more person in a group call: their video, or their photo with a speaking ring.
export default memo(function ParticipantTile({ info, snapshot, video, speakerOn }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const live = video && Boolean(snapshot.remoteStream) && snapshot.remoteHasVideo && !snapshot.remoteVideoOff;
  useMediaElement(videoRef, snapshot.remoteStream, video);
  useMediaElement(audioRef, snapshot.remoteStream);
  useEffect(() => { if (audioRef.current) audioRef.current.muted = !speakerOn; }, [speakerOn, snapshot.remoteStream]);
  const state = snapshot.status === 'connected' ? (snapshot.remoteMuted ? 'Muted' : '') : snapshot.status === 'reconnecting' ? 'Reconnecting…' : TERMINAL_STATUSES.includes(snapshot.status) ? 'Left' : 'Connecting…';
  return (
    <div className={`wa-participant ${live ? 'has-video' : ''}`}>
      {video && <video ref={videoRef} className="wa-video-element" autoPlay playsInline muted style={{ visibility: live ? 'visible' : 'hidden' }} />}
      {!live && (
        <span className="wa-speaking-wrap">
          <SpeakingIndicator stream={snapshot.remoteStream} />
          <Avatar name={info.name} initials={info.initials ?? info.name?.slice(0, 2).toUpperCase()} color={info.color} image={info.avatar} size={video ? 'normal' : 'large'} />
        </span>
      )}
      <audio ref={audioRef} autoPlay playsInline />
      <span className="wa-participant-name">{info.name}{state ? ` · ${state}` : ''}</span>
    </div>
  );
});
