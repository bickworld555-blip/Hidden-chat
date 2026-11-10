import { memo } from 'react';
import { MonitorUp, ScanFace, VideoOff } from 'lucide-react';
import Avatar from '../Avatar.jsx';
import { personaCharacter } from '../../avatar/persona.js';

// Android WebView draws a grey "play" poster on a <video> until its first frame; calls show nothing instead.
const NO_POSTER = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Your own camera: full screen while the call rings, then the small draggable tile (like WhatsApp's floating view).
export default memo(function FloatingSelfView({ selfFull, cameraOff, localVideoRef, facing, screenSharing, videoFilter, avatarStatus, avatarStats, persona, myName, me, muted, filter, canSwapTile, tileProps, groupGrid }) {
  return (
    <div
      className={`wa-video-tile ${selfFull ? 'is-full' : 'is-pip'} ${cameraOff ? 'camera-off' : ''}`}
      {...(canSwapTile && !selfFull ? tileProps : {})}
      aria-label={canSwapTile && !selfFull ? 'Swap self view to full screen' : undefined}
      title={canSwapTile && !selfFull ? 'Tap to enlarge' : undefined}
    >
      <video
        ref={localVideoRef}
        poster={NO_POSTER}
        className={`wa-video-element local-video ${facing === 'user' && !screenSharing && !videoFilter ? 'mirror' : ''} ${screenSharing ? 'is-screen' : ''}`}
        autoPlay
        playsInline
        muted
        // Android draws video on its own surface above the page, so a camera that is off must be hidden or
        // it shows as a black box over the profile picture.
        style={{ filter: filter, visibility: cameraOff && !screenSharing ? 'hidden' : 'visible' }}
      />
      {screenSharing && <span className="wa-share-badge mine"><MonitorUp size={13} /> You're sharing your screen</span>}
      {!screenSharing && avatarStatus === 'loading' && <span className="wa-share-badge mine"><ScanFace size={13} /> Loading face tracker…</span>}
      {!screenSharing && videoFilter && (
        <span className="wa-share-badge mine wa-avatar-badge" title="Avatar rendering: frames per second and tracking time per frame on this device">
          <ScanFace size={13} /> {personaCharacter(persona).name} · {avatarStats.fps} fps · {avatarStats.latencyMs} ms{avatarStats.tracking ? '' : ' · looking for your face'}
        </span>
      )}
      {cameraOff && !screenSharing && (
        <div className="wa-video-off-notice">
          <Avatar name={myName} initials={me?.initials ?? myName.slice(0, 2).toUpperCase()} color={me?.color} image={me?.avatar} size={selfFull ? 'large' : 'normal'} />
          <strong className="wa-video-off-name">{selfFull ? myName : 'You'}</strong>
          <span className="wa-video-off-status"><VideoOff size={13} aria-hidden="true" /> Camera off</span>
        </div>
      )}
      {canSwapTile && !selfFull && (
        <div className="wa-pip-label-overlay">Tap to swap</div>
      )}
      {groupGrid && <span className="wa-grid-participant-name">You{muted ? ' · Muted' : ''}</span>}
    </div>
  );
});
