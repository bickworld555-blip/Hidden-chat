// A large group call through the media relay (src/groupRelayCall.js). Full screen: a grid of people, who is
// speaking, and the same control dock as other calls. Media is end-to-end encrypted with the call key from
// the group's encrypted call card; if this device can't encrypt media, it refuses to join instead of sending
// anything readable to the relay.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ExternalE2EEKeyProvider, Room, RoomEvent, Track, isE2EESupported } from 'livekit-client';
import { Lock, Mic, MicOff, PhoneOff, Users, Video, VideoOff } from 'lucide-react';
import E2EEWorker from 'livekit-client/e2ee-worker?worker';
import { fetchRelayToken } from '../../groupRelayCall.js';

function Tile({ participant, local }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const [, refresh] = useState(0);
  useEffect(() => {
    const update = () => refresh((value) => value + 1);
    participant.on('trackSubscribed', update).on('trackUnsubscribed', update).on('trackMuted', update).on('trackUnmuted', update)
      .on('localTrackPublished', update).on('isSpeakingChanged', update);
    return () => { participant.off('trackSubscribed', update).off('trackUnsubscribed', update).off('trackMuted', update).off('trackUnmuted', update).off('localTrackPublished', update).off('isSpeakingChanged', update); };
  }, [participant]);
  const camera = participant.getTrackPublication(Track.Source.Camera);
  const microphone = participant.getTrackPublication(Track.Source.Microphone);
  const cameraTrack = camera?.track && !camera.isMuted ? camera.track : null;
  useEffect(() => {
    if (!cameraTrack || !videoRef.current) return undefined;
    cameraTrack.attach(videoRef.current);
    return () => { cameraTrack.detach(videoRef.current); };
  }, [cameraTrack]);
  useEffect(() => {
    const track = !local && microphone?.track;
    if (!track || !audioRef.current) return undefined;
    track.attach(audioRef.current);
    return () => { track.detach(audioRef.current); };
  }, [microphone?.track, local]);
  const name = local ? 'You' : participant.name || participant.identity;
  return (
    <div className={`relay-tile${participant.isSpeaking ? ' is-speaking' : ''}`}>
      {cameraTrack ? <video ref={videoRef} autoPlay playsInline muted={local} className={local ? 'is-mirrored' : ''} />
        : <span className="relay-tile-initial" aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}
      {!local && <audio ref={audioRef} autoPlay />}
      <span className="relay-tile-name">{!microphone || microphone.isMuted ? <MicOff size={13} aria-label="Muted" /> : null}{name}</span>
    </div>
  );
}

export default function GroupRelayCall({ token, groupId, groupName, call, onClose }) {
  const [room, setRoom] = useState(null);
  const [status, setStatus] = useState('Connecting…');
  const [error, setError] = useState('');
  const [participants, setParticipants] = useState([]);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(call.mode === 'video');

  useEffect(() => {
    let cancelled = false;
    let current = null;
    (async () => {
      if (!isE2EESupported()) throw new Error('This device can’t encrypt group call media, so it won’t join. Update the app or browser and try again.');
      const ticket = await fetchRelayToken(token, groupId);
      const keyProvider = new ExternalE2EEKeyProvider();
      await keyProvider.setKey(call.key);
      current = new Room({
        adaptiveStream: true,
        dynacast: true,
        e2ee: { keyProvider, worker: new E2EEWorker() },
      });
      const sync = () => { if (!cancelled) setParticipants([...current.remoteParticipants.values()]); };
      current.on(RoomEvent.ParticipantConnected, sync).on(RoomEvent.ParticipantDisconnected, sync).on(RoomEvent.TrackSubscribed, sync)
        .on(RoomEvent.Reconnecting, () => setStatus('Reconnecting…')).on(RoomEvent.Reconnected, () => setStatus(''))
        .on(RoomEvent.Disconnected, () => { if (!cancelled) setStatus('Call ended'); })
        .on(RoomEvent.EncryptionError, () => setError('A participant’s media could not be decrypted. They may be on an older app.'));
      await current.setE2EEEnabled(true);
      await current.connect(ticket.url, ticket.token);
      if (cancelled) { current.disconnect(); return; }
      await current.localParticipant.setMicrophoneEnabled(true);
      if (call.mode === 'video') await current.localParticipant.setCameraEnabled(true);
      setRoom(current);
      sync();
      setStatus('');
    })().catch((caught) => { if (!cancelled) setError(caught?.message || 'Could not join the group call.'); });
    return () => { cancelled = true; current?.disconnect(); };
  }, [token, groupId, call.key, call.mode]);

  const toggleMic = async () => { if (!room) return; await room.localParticipant.setMicrophoneEnabled(!micOn); setMicOn(!micOn); };
  const toggleCamera = async () => { if (!room) return; await room.localParticipant.setCameraEnabled(!cameraOn); setCameraOn(!cameraOn); };
  const leave = () => { room?.disconnect(); onClose?.(); };
  const count = participants.length + 1;

  return createPortal(
    <div className="relay-call" role="dialog" aria-modal="true" aria-label={`Group call in ${groupName}`}>
      <header className="relay-call-head">
        <strong>{groupName}</strong>
        <small><Lock size={12} aria-hidden="true" /> End-to-end encrypted · <Users size={12} aria-hidden="true" /> {count} {count === 1 ? 'person' : 'people'}{status ? ` · ${status}` : ''}</small>
      </header>
      {error ? <p className="relay-call-error" role="alert">{error}</p> : (
        <div className={`relay-grid count-${Math.min(count, 9)}`}>
          {room && <Tile participant={room.localParticipant} local />}
          {participants.map((participant) => <Tile key={participant.identity} participant={participant} />)}
        </div>
      )}
      <footer className="wa-video-bottom-dock relay-dock">
        <button type="button" className={`wa-dock-btn ${cameraOn ? '' : 'active'}`} onClick={toggleCamera} disabled={!room} aria-label={cameraOn ? 'Turn camera off' : 'Turn camera on'}>{cameraOn ? <Video size={22} /> : <VideoOff size={22} />}</button>
        <button type="button" className={`wa-dock-btn ${micOn ? '' : 'active'}`} onClick={toggleMic} disabled={!room} aria-label={micOn ? 'Mute microphone' : 'Unmute microphone'} aria-pressed={!micOn}>{micOn ? <Mic size={22} /> : <MicOff size={22} />}</button>
        <button type="button" className="wa-dock-btn end-call" onClick={leave} aria-label="Leave call"><PhoneOff size={22} /></button>
      </footer>
    </div>,
    document.body,
  );
}
