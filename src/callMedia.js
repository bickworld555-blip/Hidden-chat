// One microphone and one camera per call, shared by every pair connection of a group call.
//
// A group call is a mesh: one connection (src/callEngine.js) per other person. Each used to call getUserMedia on its
// own, so a three-person call opened the microphone and camera twice on each phone. Android lets one capture hold
// the camera: the second took it from the first (that person's picture froze), and the microphone captured twice
// left one connection silent (one person heard, the other not). Like WhatsApp's single capture feeding every
// participant, the call now captures once; each connection gets clones of those tracks (clones share the capture,
// open nothing, and can each be muted, switched off or stopped on their own).
//
// Captures run one at a time. A connection asking for another camera (switching to the back camera, a camera plan
// with a device id) closes the current camera first, since phones cannot open two, and every connection then takes
// a clone of the new one as it switches.

const live = (track) => Boolean(track) && track.readyState === 'live';

/**
 * createCallMediaSource({ capture }) → { get(constraints), stop() }. `capture` is getUserMedia. `get` resolves a new
 * MediaStream of clones for what the constraints ask (audio, video, or both).
 */
export function createCallMediaSource({ capture, createStream = (tracks) => new MediaStream(tracks) }) {
  let audio = null;
  let video = null;
  let videoKey = null;
  const issued = new Set();
  let chain = Promise.resolve();
  let stopped = false;

  const clone = (track) => {
    const copy = track.clone();
    issued.add(copy);
    return copy;
  };
  const forget = () => { for (const track of issued) if (!live(track)) issued.delete(track); };

  async function take(constraints) {
    if (stopped) throw Object.assign(new Error('Call closed.'), { name: 'AbortError' });
    const wantAudio = Boolean(constraints?.audio);
    const wantVideo = Boolean(constraints?.video);
    const key = wantVideo ? JSON.stringify(constraints.video) : null;
    const needAudio = wantAudio && !live(audio);
    const needVideo = wantVideo && (!live(video) || videoKey !== key);
    if (needVideo && video) {
      // Another camera: the open one (and every connection's copy of it) closes first.
      for (const track of issued) if (track.kind === 'video') try { track.stop(); } catch {}
      try { video.stop(); } catch {}
      video = null;
      videoKey = null;
    }
    if (needAudio || needVideo) {
      const stream = await capture({ audio: needAudio ? constraints.audio : false, video: needVideo ? constraints.video : false });
      const [newAudio] = needAudio ? stream.getAudioTracks() : [];
      const [newVideo] = needVideo ? stream.getVideoTracks() : [];
      // Anything captured that was not asked for is let go at once.
      for (const track of stream.getTracks()) if (track !== newAudio && track !== newVideo) try { track.stop(); } catch {}
      if (stopped) { newAudio?.stop(); newVideo?.stop(); throw Object.assign(new Error('Call closed.'), { name: 'AbortError' }); }
      if (needAudio) audio = newAudio ?? null;
      if (needVideo) { video = newVideo ?? null; videoKey = video ? key : null; }
    }
    forget();
    const tracks = [];
    if (wantAudio && audio) tracks.push(clone(audio));
    if (wantVideo && video) tracks.push(clone(video));
    if ((wantAudio && !audio) || (wantVideo && !video)) {
      for (const track of tracks) track.stop();
      throw Object.assign(new Error('The microphone or camera gave no track.'), { name: 'NotReadableError' });
    }
    return createStream(tracks);
  }

  return {
    get(constraints) {
      const result = chain.then(() => take(constraints));
      chain = result.catch(() => {});
      return result;
    },
    /** The call is over: the shared captures and every copy still open close. */
    stop() {
      stopped = true;
      for (const track of [audio, video, ...issued]) if (track) try { track.stop(); } catch {}
      issued.clear();
      audio = null;
      video = null;
    },
  };
}
