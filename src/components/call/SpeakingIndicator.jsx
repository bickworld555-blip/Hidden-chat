import { memo, useEffect, useRef } from 'react';
import { meterStream, smoothLevel } from '../../audioLevel.js';

// A soft ring around a participant's photo that grows with their voice (WhatsApp's VoiceParticipantAudioWave):
// drawn on a canvas every animation frame straight from the audio analyser. No React state is touched while it
// animates, so speaking never re-renders the call screen.
export default memo(function SpeakingIndicator({ stream, color = '#25d366' }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const meter = meterStream(stream);
    if (!canvas || !meter) return undefined;
    const context = canvas.getContext('2d');
    let level = 0;
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const ratio = window.devicePixelRatio || 1;
      const size = canvas.clientWidth * ratio;
      if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
      level = smoothLevel(level, meter.level());
      context.clearRect(0, 0, size, size);
      if (level < 0.04) return;
      const center = size / 2;
      const inner = center * 0.72;
      context.beginPath();
      context.arc(center, center, inner + (center - inner) * level, 0, Math.PI * 2);
      context.fillStyle = color;
      context.globalAlpha = 0.18 + 0.32 * level;
      context.fill();
      context.globalAlpha = 1;
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      meter.stop();
    };
  }, [stream, color]);

  return <canvas ref={canvasRef} className="wa-speaking-ring" aria-hidden="true" />;
});
