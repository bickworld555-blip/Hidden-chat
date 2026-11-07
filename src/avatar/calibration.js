// Face scan: a small state machine that walks the user through centre → left → right → up → down → blink,
// records how far their head actually turns (the profile), and learns which way the tracker's yaw/pitch
// signs point so the avatar always mirrors the person correctly. Pure and timer-free: callers pass dt.

export const CALIBRATION_STEPS = Object.freeze([
  { id: 'center', label: 'Look straight at the camera', hint: 'Keep your face inside the frame' },
  { id: 'left', label: 'Turn your head to the left', hint: 'Slowly, until the ring fills' },
  { id: 'right', label: 'Now turn to the right', hint: 'All the way, then hold' },
  { id: 'up', label: 'Tilt your head up', hint: 'Chin up a little' },
  { id: 'down', label: 'Tilt your head down', hint: 'Chin towards your chest' },
  { id: 'blink', label: 'Blink twice', hint: 'Nice and clearly' },
]);

export const CALIBRATION_THRESHOLDS = Object.freeze({ centerDeg: 10, turnDeg: 18, tiltDeg: 12, blink: 0.55, holdMs: 450, blinks: 2 });

export function createCalibration() {
  return {
    stepIndex: 0,
    heldMs: 0,
    done: false,
    blinks: 0,
    blinkClosed: false,
    profile: { yawSign: 1, pitchSign: 1, yawMax: 0, yawMin: 0, pitchMax: 0, pitchMin: 0, blinkMax: 0 },
    lastPresent: false,
  };
}

export function currentStep(state) {
  return CALIBRATION_STEPS[Math.min(state.stepIndex, CALIBRATION_STEPS.length - 1)];
}

export function calibrationProgress(state) {
  if (state.done) return 1;
  const step = currentStep(state);
  const within = step.id === 'blink' ? state.blinks / CALIBRATION_THRESHOLDS.blinks : Math.min(1, state.heldMs / CALIBRATION_THRESHOLDS.holdMs);
  return (state.stepIndex + within) / CALIBRATION_STEPS.length;
}

function stepSatisfied(step, expression, profile, t) {
  const blink = Math.max(expression.blinkLeft, expression.blinkRight);
  switch (step.id) {
    case 'center': return Math.abs(expression.yaw) < t.centerDeg && Math.abs(expression.pitch) < t.centerDeg && blink < t.blink;
    // The first strong turn defines which sign means "left" for this tracker/camera; "right" must be the opposite.
    case 'left': return Math.abs(expression.yaw) > t.turnDeg;
    case 'right': return Math.sign(expression.yaw) === -profile.yawSign && Math.abs(expression.yaw) > t.turnDeg;
    case 'up': return Math.abs(expression.pitch) > t.tiltDeg;
    case 'down': return Math.sign(expression.pitch) === -profile.pitchSign && Math.abs(expression.pitch) > t.tiltDeg;
    default: return false;
  }
}

export function advanceCalibration(state, expression, dtMs, thresholds = CALIBRATION_THRESHOLDS) {
  if (state.done) return state;
  if (!expression?.present) return state.heldMs || state.lastPresent ? { ...state, heldMs: 0, lastPresent: false } : state;
  const t = thresholds;
  const step = currentStep(state);
  const profile = { ...state.profile };
  const blink = Math.max(expression.blinkLeft, expression.blinkRight);
  profile.yawMax = Math.max(profile.yawMax, expression.yaw);
  profile.yawMin = Math.min(profile.yawMin, expression.yaw);
  profile.pitchMax = Math.max(profile.pitchMax, expression.pitch);
  profile.pitchMin = Math.min(profile.pitchMin, expression.pitch);
  profile.blinkMax = Math.max(profile.blinkMax, blink);

  let next = { ...state, profile, lastPresent: true };
  if (step.id === 'blink') {
    const closed = blink > t.blink;
    if (closed && !state.blinkClosed) next.blinks = state.blinks + 1;
    next.blinkClosed = closed;
    if (next.blinks >= t.blinks) next = complete(next);
    return next;
  }
  if (!stepSatisfied(step, expression, profile, t)) return { ...next, heldMs: 0 };
  next.heldMs = state.heldMs + Math.max(0, dtMs);
  if (next.heldMs < t.holdMs) return next;
  if (step.id === 'left') profile.yawSign = Math.sign(expression.yaw) || 1;
  if (step.id === 'up') profile.pitchSign = Math.sign(expression.pitch) || 1;
  return complete({ ...next, profile });
}

function complete(state) {
  const stepIndex = state.stepIndex + 1;
  return { ...state, stepIndex, heldMs: 0, done: stepIndex >= CALIBRATION_STEPS.length };
}

// The saved profile: the ranges the person comfortably reaches, used to scale avatar head motion.
export function profileFromCalibration(state) {
  const p = state.profile;
  return {
    yawSign: p.yawSign,
    pitchSign: p.pitchSign,
    yawRange: Math.max(15, Math.min(60, Math.max(Math.abs(p.yawMax), Math.abs(p.yawMin)))),
    pitchRange: Math.max(10, Math.min(45, Math.max(Math.abs(p.pitchMax), Math.abs(p.pitchMin)))),
    blinkMax: Math.max(0.5, Math.min(1, p.blinkMax || 0.8)),
  };
}

// Applies the profile so head motion and blinks are normalised per person and point the right way.
export function personalize(expression, profile) {
  const yaw = (expression.yaw * (profile?.yawSign ?? 1)) / (profile?.yawRange ?? 30);
  const pitch = (expression.pitch * (profile?.pitchSign ?? 1)) / (profile?.pitchRange ?? 20);
  const blinkScale = 1 / (profile?.blinkMax ?? 0.8);
  return {
    ...expression,
    turn: Math.max(-1, Math.min(1, yaw)),
    nod: Math.max(-1, Math.min(1, pitch)),
    blinkLeft: Math.min(1, expression.blinkLeft * blinkScale),
    blinkRight: Math.min(1, expression.blinkRight * blinkScale),
  };
}
