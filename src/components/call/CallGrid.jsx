import { memo } from 'react';
import { MicOff, MonitorUp, ScanFace } from 'lucide-react';
import Avatar from '../Avatar.jsx';
import ParticipantTile from './ParticipantTile.jsx';
import FloatingSelfView from './FloatingSelfView.jsx';
import { CallStatusLabel } from './CallTimer.jsx';

const NO_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// The video stage (like WhatsApp's CallGrid): the other person full screen, your own floating tile, and one tile
// per extra participant in a group call. Memoized: it redraws only when what it shows changes, never for the timer.
export default memo(function CallGrid({ stageRef, groupGrid, swapped, remoteVideoLive, canSwapTile, remoteStream, tileProps, remoteVideoRef, remoteScreen, filter, peerName, remoteAvatar, peer, status, remoteVideoOff, remoteMuted, extraPeers, audioMuted, self }) {
  return (
    <div className={`wa-video-stage ${groupGrid ? 'is-group' : ''}`} ref={stageRef}>
      {/* Remote video tile (Full by default, or PiP when swapped) */}
      <div
        className={`wa-video-tile ${swapped ? 'is-pip' : 'is-full'} ${!remoteVideoLive ? 'waiting-remote' : ''}`}
        {...(canSwapTile && swapped && remoteStream ? tileProps : {})}
        aria-label={canSwapTile && swapped ? 'Swap remote video to full screen' : undefined}
        title={canSwapTile && swapped ? 'Tap to enlarge' : undefined}
      >
        <video
          ref={remoteVideoRef}
          poster={NO_POSTER}
          className={`wa-video-element remote-video ${remoteScreen ? 'is-screen' : ''}`}
          autoPlay
          playsInline
          muted
          style={{ filter: filter, visibility: remoteVideoLive ? 'visible' : 'hidden' }}
        />
        {remoteScreen && remoteVideoLive && <span className="wa-share-badge"><MonitorUp size={13} /> {peerName} is sharing their screen</span>}
        {remoteAvatar && !remoteScreen && remoteVideoLive && <span className="wa-share-badge"><ScanFace size={13} /> {peerName} is using a cartoon avatar</span>}
        {!remoteVideoLive && (
          <div className="wa-video-waiting-placeholder">
            <div className="wa-waiting-avatar">
              <Avatar name={peerName} initials={peer?.initials ?? peerName.slice(0, 2).toUpperCase()} color={peer?.color} image={peer?.avatar} size="large" />
            </div>
            <strong className="wa-waiting-name">{peerName}</strong>
            <span className="wa-waiting-status">{remoteStream && status === 'connected' ? (remoteVideoOff ? 'Camera off' : 'Voice only') : <CallStatusLabel />}</span>
          </div>
        )}
        {remoteMuted && status === 'connected' && (
          <span className="wa-remote-muted-badge" title={`${peerName} is muted`}><MicOff size={14} /></span>
        )}
        {canSwapTile && swapped && remoteStream && (
          <div className="wa-pip-label-overlay">Tap to swap</div>
        )}
        {groupGrid && <span className="wa-grid-participant-name">{peerName}</span>}
      </div>

      <FloatingSelfView {...self} filter={filter} canSwapTile={canSwapTile} tileProps={tileProps} groupGrid={groupGrid} />
      {extraPeers.map(({ peerId, info, snapshot: item }) => (
        <ParticipantTile key={peerId} info={info} snapshot={item} video speakerOn={!audioMuted} />
      ))}
    </div>
  );
});
