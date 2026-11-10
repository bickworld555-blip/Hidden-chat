import { useEffect } from 'react';

// Binds a MediaStream to a <video>/<audio> element and keeps it bound as tracks come and go.
export function useMediaElement(ref, stream, enabled = true) {
  const tracksKey = stream?.getTracks().map((track) => track.id).join('|') ?? '';
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return undefined;
    let boundStream = null;
    const bind = () => {
      boundStream = stream ? new MediaStream(stream.getTracks()) : null;
      element.srcObject = boundStream;
      if (boundStream) element.play?.().catch((error) => console.warn('Call media playback failed:', error));
    };
    bind();
    stream?.addEventListener('addtrack', bind);
    stream?.addEventListener('removetrack', bind);
    return () => {
      stream?.removeEventListener('addtrack', bind);
      stream?.removeEventListener('removetrack', bind);
      if (element.srcObject === boundStream) element.srcObject = null;
    };
  }, [ref, stream, enabled, tracksKey]);
}
