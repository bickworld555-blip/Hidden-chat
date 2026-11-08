import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, RefreshCw, ScanFace, X } from 'lucide-react';
import { loadFaceTracker } from '../avatar/faceTracker.js';
import { expressionFromResult, smoothExpression } from '../avatar/expression.js';
import { CALIBRATION_STEPS, advanceCalibration, calibrationProgress, createCalibration, currentStep, personalize, profileFromCalibration } from '../avatar/calibration.js';
import { CHARACTERS, CHARACTER_GROUPS, drawAvatar, idleExpression } from '../avatar/characters.js';
import { getPersona, savePersona } from '../avatar/persona.js';

const PREVIEW_SIZE = 160;

// One live canvas per character; all of them mirror the same expression so the choice is made "in motion".
function CharacterPreview({ character, expressionRef, selected, onSelect }) {
  const canvasRef = useRef(null);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return undefined;
    let frame = 0;
    let last = -Infinity;
    // Fifteen live previews: the chosen one animates every frame, the rest at ~20 fps, and off-screen ones rest.
    let visible = true;
    const observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; })
      : null;
    observer?.observe(canvasRef.current);
    const draw = (now) => {
      if (visible && (selectedRef.current || now - last >= 50)) {
        last = now;
        drawAvatar(ctx, character, expressionRef.current ?? idleExpression(now), PREVIEW_SIZE);
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); observer?.disconnect(); };
  }, [character, expressionRef]);
  return (
    <button type="button" className={`avatar-choice${selected ? ' is-selected' : ''}`} onClick={() => onSelect(character.id)} aria-pressed={selected} aria-label={`${character.name}: ${character.tagline}`}>
      <canvas ref={canvasRef} width={PREVIEW_SIZE} height={PREVIEW_SIZE} />
      <strong>{character.name}</strong>
      <small>{character.tagline}</small>
      {selected && <span className="avatar-choice-check"><Check size={14} /></span>}
    </button>
  );
}

// Face scan + character choice. Saves the persona and reports it back; nothing leaves the device.
export default function AvatarStudio({ onClose, onSaved, startAt = 'scan' }) {
  const existing = getPersona();
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const trackerRef = useRef(null);
  const expressionRef = useRef(null);
  const rawRef = useRef(null);
  const [phase, setPhase] = useState('loading'); // loading | scan | choose | saving
  const [loadNote, setLoadNote] = useState('Starting the camera…');
  const [error, setError] = useState('');
  const [calibration, setCalibration] = useState(createCalibration);
  const calibrationRef = useRef(calibration);
  calibrationRef.current = calibration;
  const [characterId, setCharacterId] = useState(existing?.characterId ?? CHARACTERS[0].id);
  const [profile, setProfile] = useState(existing?.profile ?? null);
  const [stats, setStats] = useState({ fps: 0, latencyMs: 0 });
  const skipScan = startAt === 'choose' && Boolean(existing?.profile);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const profileRef = useRef(profile);
  profileRef.current = profile;

  // Camera + tracker lifecycle.
  useEffect(() => {
    let cancelled = false;
    let stopLoop = null;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
        if (cancelled) { stream.getTracks().forEach((track) => track.stop()); return; }
        streamRef.current = stream;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play().catch(() => {});
        setLoadNote('Loading the face tracker…');
        const tracker = await loadFaceTracker({ onProgress: (info) => { if (info.stage === 'model') setLoadNote(info.source === 'network' ? 'Downloading the face model (3.6 MB, one time)…' : 'Preparing the face model…'); } });
        if (cancelled) return;
        trackerRef.current = tracker;
        const release = tracker.acquire();
        setPhase(skipScan ? 'choose' : 'scan');
        let last = performance.now();
        let frames = 0; let windowStart = last; let latencySum = 0;
        const tick = (now) => {
          if (cancelled) return;
          const t0 = performance.now();
          if (video.readyState >= 2 && video.videoWidth) {
            let expression = null;
            try { expression = expressionFromResult(tracker.detect(video, now)); } catch { expression = null; }
            rawRef.current = expression;
            expressionRef.current = smoothExpression(expressionRef.current, expression?.present ? personalize(expression, profileRef.current) : idleExpression(now));
            const dt = now - last;
            if (phaseRef.current === 'scan' && expression) {
              const next = advanceCalibration(calibrationRef.current, expression, dt);
              if (next !== calibrationRef.current) { calibrationRef.current = next; setCalibration(next); }
              if (next.done) {
                const learned = profileFromCalibration(next);
                profileRef.current = learned;
                setProfile(learned);
                setPhase('choose');
              }
            }
          }
          last = now;
          frames += 1; latencySum += performance.now() - t0;
          if (now - windowStart >= 1000) { setStats({ fps: Math.round((frames * 1000) / (now - windowStart)), latencyMs: Math.round(latencySum / frames) }); frames = 0; latencySum = 0; windowStart = now; }
          handle = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
        };
        let handle = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
        stopLoop = () => { release(); if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle); else cancelAnimationFrame(handle); };
      } catch (caught) {
        if (cancelled) return;
        setError(caught?.name === 'NotAllowedError' ? 'Allow camera access to scan your face.' : caught?.message || 'The face scanner could not start.');
        setPhase('error');
      }
    })();
    return () => {
      cancelled = true;
      stopLoop?.();
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [skipScan]);

  const step = currentStep(calibration);
  const progress = calibrationProgress(calibration);
  const selected = useMemo(() => CHARACTERS.find((character) => character.id === characterId) ?? CHARACTERS[0], [characterId]);

  function rescan() {
    const fresh = createCalibration();
    calibrationRef.current = fresh;
    setCalibration(fresh);
    setPhase('scan');
  }

  function save() {
    setPhase('saving');
    const persona = savePersona({ characterId: selected.id, profile: profile ?? existing?.profile ?? null, calibratedAt: new Date().toISOString() });
    onSaved?.(persona);
    onClose?.();
  }

  return (
    <div className="avatar-studio-backdrop" role="presentation">
      <div className="avatar-studio" role="dialog" aria-modal="true" aria-labelledby="avatar-studio-title">
        <header>
          <ScanFace size={22} />
          <h2 id="avatar-studio-title">{phase === 'choose' ? 'Choose your character' : 'Scan your face'}</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </header>

        <div className={`avatar-studio-stage${phase === 'choose' ? ' is-choosing' : ''}`}>
          <div className="avatar-scan-view">
            <video ref={videoRef} muted playsInline autoPlay className="avatar-scan-video" />
            {phase === 'scan' && (
              <>
                <svg className="avatar-scan-ring" viewBox="0 0 100 100" aria-hidden="true">
                  <circle cx="50" cy="50" r="46" />
                  <circle cx="50" cy="50" r="46" className="progress" style={{ strokeDashoffset: `${(1 - progress) * 289}` }} />
                </svg>
                {rawRef.current && !rawRef.current.present && <span className="avatar-scan-note">Move your face into the frame</span>}
              </>
            )}
            {(phase === 'loading' || phase === 'error') && (
              <div className="avatar-scan-overlay">{error ? <p role="alert">{error}</p> : <p role="status">{loadNote}</p>}</div>
            )}
            {phase !== 'loading' && phase !== 'error' && <span className="avatar-stats-badge">{stats.fps} fps · {stats.latencyMs} ms</span>}
          </div>

          {phase === 'scan' && (
            <div className="avatar-scan-steps">
              <p className="avatar-scan-instruction"><strong>{step.label}</strong><small>{step.hint}</small></p>
              <ol>
                {CALIBRATION_STEPS.map((item, index) => (
                  <li key={item.id} className={index < calibration.stepIndex ? 'is-done' : index === calibration.stepIndex ? 'is-active' : ''}>
                    <span className="avatar-step-dot">{index < calibration.stepIndex ? <Check size={12} /> : index + 1}</span>
                    {item.label}
                  </li>
                ))}
              </ol>
              {existing?.profile && <button type="button" className="avatar-link" onClick={() => setPhase('choose')}>Keep my previous scan</button>}
            </div>
          )}

          {phase === 'choose' && (
            <div className="avatar-choose">
              <p className="avatar-choose-lead">Each character is already following your face. Pick the one that feels like you.</p>
              {CHARACTER_GROUPS.map((group) => (
                <section key={group.id} className="avatar-choice-group" aria-label={group.label}>
                  <h3>{group.label}</h3>
                  <div className="avatar-choice-grid">
                    {CHARACTERS.filter((character) => character.group === group.id).map((character) => (
                      <CharacterPreview key={character.id} character={character} expressionRef={expressionRef} selected={character.id === characterId} onSelect={setCharacterId} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>

        <footer>
          {phase === 'choose' ? (
            <>
              <button type="button" className="avatar-secondary" onClick={rescan}><RefreshCw size={16} /> Scan again</button>
              <button type="button" className="avatar-primary" onClick={save}>Use {selected.name}</button>
            </>
          ) : phase === 'error' ? (
            <button type="button" className="avatar-primary" onClick={onClose}>Close</button>
          ) : (
            <small className="avatar-foot-note">Tracking runs on this device only. Nothing from the scan is uploaded.</small>
          )}
        </footer>
      </div>
    </div>
  );
}
