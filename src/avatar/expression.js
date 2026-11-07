// Turns a MediaPipe Face Landmarker result into a small, stable expression state the avatar renderer draws
// from. Pure: no DOM, no MediaPipe import, so the mapping is testable and the renderer stays tracker-agnostic.

export const NEUTRAL_EXPRESSION = Object.freeze({
  present: false,
  // 0..1 amounts
  blinkLeft: 0, blinkRight: 0, jawOpen: 0, smile: 0, pucker: 0, browUp: 0, browDown: 0, eyeWide: 0, cheekPuff: 0,
  // head pose in degrees, position/scale of the face in the frame (normalised 0..1 / relative)
  yaw: 0, pitch: 0, roll: 0, x: 0.5, y: 0.5, scale: 1,
  // -1..1 gaze offsets
  gazeX: 0, gazeY: 0,
});

const clamp01 = (value) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const toDegrees = (radians) => (radians * 180) / Math.PI;
const round1 = (value) => Math.round(value * 10) / 10 || 0;

// MediaPipe blendshape categories are a flat list of { categoryName, score }.
export function blendshapeMap(categories) {
  const map = Object.create(null);
  for (const item of categories ?? []) if (item?.categoryName) map[item.categoryName] = clamp01(item.score);
  return map;
}

// Yaw/pitch/roll (degrees) from a column-major 4x4 facial transformation matrix.
export function headPoseFromMatrix(data) {
  if (!data || data.length < 12) return { yaw: 0, pitch: 0, roll: 0 };
  // Column-major: column i occupies data[i*4 .. i*4+3].
  const r00 = data[0]; const r10 = data[1]; const r20 = data[2];
  const r21 = data[6];
  const r22 = data[10];
  const yaw = toDegrees(Math.atan2(-r20, Math.hypot(r00, r10)));
  const pitch = toDegrees(Math.atan2(r21, r22));
  const roll = toDegrees(Math.atan2(r10, r00));
  return { yaw: round1(yaw), pitch: round1(pitch), roll: round1(roll) };
}

export function faceBox(landmarks) {
  if (!landmarks?.length) return null;
  let minX = 1; let minY = 1; let maxX = 0; let maxY = 0;
  for (const point of landmarks) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY };
}

export function expressionFromResult(result, { mirror = true } = {}) {
  const landmarks = result?.faceLandmarks?.[0];
  if (!landmarks?.length) return { ...NEUTRAL_EXPRESSION };
  const shapes = blendshapeMap(result.faceBlendshapes?.[0]?.categories);
  const pose = headPoseFromMatrix(result.facialTransformationMatrixes?.[0]?.data);
  const box = faceBox(landmarks);
  const gazeX = (shapes.eyeLookOutLeft ?? 0) - (shapes.eyeLookInLeft ?? 0) + (shapes.eyeLookInRight ?? 0) - (shapes.eyeLookOutRight ?? 0);
  const gazeY = (shapes.eyeLookDownLeft ?? 0) + (shapes.eyeLookDownRight ?? 0) - (shapes.eyeLookUpLeft ?? 0) - (shapes.eyeLookUpRight ?? 0);
  const sign = mirror ? -1 : 1;
  return {
    present: true,
    blinkLeft: shapes.eyeBlinkLeft ?? 0,
    blinkRight: shapes.eyeBlinkRight ?? 0,
    jawOpen: shapes.jawOpen ?? 0,
    smile: clamp01(((shapes.mouthSmileLeft ?? 0) + (shapes.mouthSmileRight ?? 0)) / 2),
    pucker: clamp01(Math.max(shapes.mouthPucker ?? 0, shapes.mouthFunnel ?? 0)),
    browUp: clamp01(Math.max(shapes.browInnerUp ?? 0, ((shapes.browOuterUpLeft ?? 0) + (shapes.browOuterUpRight ?? 0)) / 2)),
    browDown: clamp01(((shapes.browDownLeft ?? 0) + (shapes.browDownRight ?? 0)) / 2),
    eyeWide: clamp01(((shapes.eyeWideLeft ?? 0) + (shapes.eyeWideRight ?? 0)) / 2),
    cheekPuff: shapes.cheekPuff ?? 0,
    yaw: round1(pose.yaw * sign),
    pitch: pose.pitch,
    roll: round1(pose.roll * sign),
    x: mirror ? 1 - box.x : box.x,
    y: box.y,
    scale: Math.max(0.3, Math.min(2.5, box.width / 0.35)),
    gazeX: Math.max(-1, Math.min(1, gazeX * sign * 0.5)),
    gazeY: Math.max(-1, Math.min(1, gazeY * 0.5)),
  };
}

// Exponential smoothing with faster response for fast-moving channels (blink, mouth) so lip-sync stays crisp.
const FAST = new Set(['blinkLeft', 'blinkRight', 'jawOpen']);
export function smoothExpression(previous, next, { slow = 0.35, fast = 0.75 } = {}) {
  if (!previous) return { ...next };
  const out = { ...previous };
  for (const key of Object.keys(next)) {
    const value = next[key];
    if (typeof value !== 'number' || typeof previous[key] !== 'number') { out[key] = value; continue; }
    const alpha = FAST.has(key) ? fast : slow;
    out[key] = previous[key] + (value - previous[key]) * alpha;
  }
  return out;
}

// Drives the avatar's mouth from the microphone when the tracker cannot see a mouth (e.g. hand in front).
export function mouthFromAudioLevel(level, current) {
  const target = clamp01((level - 0.04) * 4);
  return Math.max(current, target * 0.6);
}
