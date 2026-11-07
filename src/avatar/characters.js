// Five original cartoon characters and the canvas renderer that animates them from an expression state.
// Everything is procedural (no image assets), so it draws at any size and ships with no downloads.

export const CHARACTERS = Object.freeze([
  { id: 'sunny', name: 'Sunny', tagline: 'Warm and freckled', shape: 'round', skin: '#f7c9a6', blush: '#f29e8e', hair: '#e2632b', hairStyle: 'curls', eyes: '#4b3a2f', bg: ['#ffd9a0', '#ff9a62'], features: ['freckles'] },
  { id: 'pixel', name: 'Pixel', tagline: 'A friendly little robot', shape: 'square', skin: '#9fd4ff', blush: '#6fb6ff', hair: '#2a5f8a', hairStyle: 'antenna', eyes: '#0b2a45', bg: ['#dff3ff', '#6cb8ff'], features: ['visor', 'bolts'] },
  { id: 'momo', name: 'Momo', tagline: 'Curious cat', shape: 'cat', skin: '#f3e3c8', blush: '#f1b2a4', hair: '#d9a86c', hairStyle: 'ears', eyes: '#2e7d4f', bg: ['#fff1d6', '#f6b26b'], features: ['whiskers', 'nose'] },
  { id: 'indigo', name: 'Indigo', tagline: 'Cool, with glasses', shape: 'oval', skin: '#b79cf0', blush: '#9b7be6', hair: '#2b1b4f', hairStyle: 'mohawk', eyes: '#1b1240', bg: ['#e4dcff', '#8f6bff'], features: ['glasses'] },
  { id: 'bean', name: 'Bean', tagline: 'Bouncy green blob', shape: 'blob', skin: '#9be27a', blush: '#6cc35a', hair: '#4f9a3a', hairStyle: 'sprout', eyes: '#173d12', bg: ['#e7ffd9', '#7fd66a'], features: ['dimples'] },
]);

export function characterById(id) {
  return CHARACTERS.find((character) => character.id === id) ?? null;
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// Idle motion when nobody is in frame: a slow breathe and an occasional blink, so the avatar never freezes.
export function idleExpression(timeMs) {
  const t = timeMs / 1000;
  const blinkPhase = t % 3.6;
  const blink = blinkPhase > 3.3 ? Math.sin(((blinkPhase - 3.3) / 0.3) * Math.PI) : 0;
  return { present: false, blinkLeft: blink, blinkRight: blink, jawOpen: 0, smile: 0.15, pucker: 0, browUp: 0, browDown: 0, eyeWide: 0, cheekPuff: 0, yaw: 0, pitch: 0, roll: Math.sin(t * 0.8) * 1.5, x: 0.5, y: 0.5 + Math.sin(t * 1.4) * 0.006, scale: 1, gazeX: Math.sin(t * 0.5) * 0.2, gazeY: 0, turn: Math.sin(t * 0.6) * 0.08, nod: Math.sin(t * 1.4) * 0.04 };
}

function headPath(ctx, shape, r) {
  ctx.beginPath();
  if (shape === 'square') {
    const k = r * 0.28;
    ctx.moveTo(-r + k, -r); ctx.lineTo(r - k, -r); ctx.quadraticCurveTo(r, -r, r, -r + k);
    ctx.lineTo(r, r - k); ctx.quadraticCurveTo(r, r, r - k, r);
    ctx.lineTo(-r + k, r); ctx.quadraticCurveTo(-r, r, -r, r - k);
    ctx.lineTo(-r, -r + k); ctx.quadraticCurveTo(-r, -r, -r + k, -r);
  } else if (shape === 'oval') {
    ctx.ellipse(0, 0, r * 0.88, r * 1.08, 0, 0, Math.PI * 2);
  } else if (shape === 'blob') {
    ctx.moveTo(0, -r);
    ctx.bezierCurveTo(r * 0.9, -r, r * 1.1, r * 0.4, r * 0.6, r * 0.9);
    ctx.bezierCurveTo(r * 0.2, r * 1.15, -r * 0.2, r * 1.15, -r * 0.6, r * 0.9);
    ctx.bezierCurveTo(-r * 1.1, r * 0.4, -r * 0.9, -r, 0, -r);
  } else if (shape === 'cat') {
    ctx.ellipse(0, r * 0.05, r * 1.02, r * 0.92, 0, 0, Math.PI * 2);
  } else {
    ctx.arc(0, 0, r, 0, Math.PI * 2);
  }
  ctx.closePath();
}

function drawHair(ctx, character, r, turn) {
  ctx.fillStyle = character.hair;
  switch (character.hairStyle) {
    case 'curls':
      for (let i = -3; i <= 3; i += 1) {
        ctx.beginPath();
        ctx.arc(i * r * 0.3 + turn * r * 0.15, -r * 0.82 - Math.abs(i) * -r * 0.04 + Math.abs(i) * r * 0.05, r * 0.26, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'antenna':
      ctx.fillRect(-r * 0.06 + turn * r * 0.1, -r * 1.35, r * 0.12, r * 0.4);
      ctx.beginPath(); ctx.arc(turn * r * 0.1, -r * 1.4, r * 0.13, 0, Math.PI * 2); ctx.fill();
      break;
    case 'ears':
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * r * 0.35 + turn * r * 0.2, -r * 0.65);
        ctx.lineTo(side * r * 0.95 + turn * r * 0.2, -r * 1.35);
        ctx.lineTo(side * r * 0.98 + turn * r * 0.2, -r * 0.45);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = character.blush;
        ctx.beginPath();
        ctx.moveTo(side * r * 0.5 + turn * r * 0.2, -r * 0.7);
        ctx.lineTo(side * r * 0.85 + turn * r * 0.2, -r * 1.15);
        ctx.lineTo(side * r * 0.88 + turn * r * 0.2, -r * 0.6);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = character.hair;
      }
      break;
    case 'mohawk':
      ctx.beginPath();
      ctx.moveTo(-r * 0.3 + turn * r * 0.2, -r * 0.75);
      for (let i = 0; i <= 6; i += 1) {
        const x = lerp(-r * 0.3, r * 0.3, i / 6) + turn * r * 0.2;
        ctx.lineTo(x, -r * (1.05 + (i % 2 ? 0.3 : 0.1)));
      }
      ctx.lineTo(r * 0.3 + turn * r * 0.2, -r * 0.75);
      ctx.closePath(); ctx.fill();
      break;
    case 'sprout':
      ctx.strokeStyle = character.hair; ctx.lineWidth = r * 0.07; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(turn * r * 0.1, -r * 0.95); ctx.quadraticCurveTo(turn * r * 0.1 + r * 0.15, -r * 1.3, turn * r * 0.1 + r * 0.05, -r * 1.45); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(turn * r * 0.1 + r * 0.2, -r * 1.42, r * 0.18, r * 0.1, -0.5, 0, Math.PI * 2); ctx.fill();
      break;
    default:
      break;
  }
}

function drawEye(ctx, character, cx, cy, r, blink, wide, gazeX, gazeY) {
  const eyeW = r * 0.19;
  const eyeH = r * (0.19 + wide * 0.06) * (1 - clamp(blink, 0, 1) * 0.92);
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.ellipse(cx, cy, eyeW, Math.max(eyeH, r * 0.012), 0, 0, Math.PI * 2); ctx.fill();
  if (eyeH > r * 0.04) {
    ctx.fillStyle = character.eyes;
    ctx.beginPath(); ctx.ellipse(cx + gazeX * eyeW * 0.45, cy + gazeY * eyeH * 0.4, eyeW * 0.5, Math.min(eyeH * 0.8, eyeW * 0.55), 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(cx + gazeX * eyeW * 0.45 - eyeW * 0.18, cy + gazeY * eyeH * 0.4 - eyeH * 0.25, eyeW * 0.14, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.strokeStyle = character.eyes; ctx.lineWidth = r * 0.04; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx - eyeW, cy); ctx.quadraticCurveTo(cx, cy + r * 0.06, cx + eyeW, cy); ctx.stroke();
  }
}

function drawMouth(ctx, character, r, e) {
  const open = clamp(e.jawOpen, 0, 1);
  const smile = clamp(e.smile, 0, 1);
  const pucker = clamp(e.pucker, 0, 1);
  const cy = r * 0.45 + e.nod * -r * 0.04;
  const width = r * (0.42 - pucker * 0.22 + smile * 0.1);
  const height = r * (0.04 + open * 0.42);
  ctx.fillStyle = '#5a1f2b';
  ctx.beginPath();
  if (open > 0.08) {
    ctx.ellipse(0, cy + height * 0.4, width * 0.55, height * 0.55, 0, 0, Math.PI * 2);
    ctx.fill();
    // Teeth and tongue when the mouth is open enough — reads as speech even on small tiles.
    if (open > 0.3) {
      ctx.fillStyle = '#fff';
      ctx.fillRect(-width * 0.4, cy - height * 0.1, width * 0.8, Math.min(height * 0.22, r * 0.07));
      ctx.fillStyle = '#e4697d';
      ctx.beginPath(); ctx.ellipse(0, cy + height * 0.7, width * 0.3, height * 0.25, 0, 0, Math.PI); ctx.fill();
    }
  } else {
    ctx.strokeStyle = '#5a1f2b'; ctx.lineWidth = r * 0.045; ctx.lineCap = 'round';
    ctx.moveTo(-width * 0.5, cy);
    ctx.quadraticCurveTo(0, cy + (smile * 0.35 - 0.05 + pucker * -0.1) * r, width * 0.5, cy);
    ctx.stroke();
  }
}

function drawFeatures(ctx, character, r, e, turn) {
  const features = character.features ?? [];
  if (features.includes('freckles')) {
    ctx.fillStyle = 'rgba(160, 90, 50, .55)';
    for (const [x, y] of [[-0.42, 0.18], [-0.34, 0.26], [-0.26, 0.17], [0.42, 0.18], [0.34, 0.26], [0.26, 0.17]]) {
      ctx.beginPath(); ctx.arc(x * r + turn * r * 0.1, y * r, r * 0.025, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (features.includes('whiskers')) {
    ctx.strokeStyle = 'rgba(80, 60, 40, .6)'; ctx.lineWidth = r * 0.02;
    for (const side of [-1, 1]) for (const dy of [-0.05, 0.05, 0.15]) {
      ctx.beginPath(); ctx.moveTo(side * r * 0.3 + turn * r * 0.1, r * (0.3 + dy)); ctx.lineTo(side * r * 0.95 + turn * r * 0.1, r * (0.22 + dy * 1.6)); ctx.stroke();
    }
  }
  if (features.includes('nose')) {
    ctx.fillStyle = character.blush;
    ctx.beginPath(); ctx.moveTo(turn * r * 0.1 - r * 0.08, r * 0.22); ctx.lineTo(turn * r * 0.1 + r * 0.08, r * 0.22); ctx.lineTo(turn * r * 0.1, r * 0.32); ctx.closePath(); ctx.fill();
  }
  if (features.includes('glasses')) {
    ctx.strokeStyle = '#1b1240'; ctx.lineWidth = r * 0.04;
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(side * r * 0.36 + turn * r * 0.22, -r * 0.08 + e.nod * -r * 0.05, r * 0.25, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(-r * 0.11 + turn * r * 0.22, -r * 0.08); ctx.lineTo(r * 0.11 + turn * r * 0.22, -r * 0.08); ctx.stroke();
  }
  if (features.includes('visor')) {
    ctx.strokeStyle = 'rgba(11, 42, 69, .35)'; ctx.lineWidth = r * 0.05;
    ctx.beginPath(); ctx.moveTo(-r * 0.7 + turn * r * 0.2, -r * 0.1); ctx.lineTo(r * 0.7 + turn * r * 0.2, -r * 0.1); ctx.stroke();
  }
  if (features.includes('bolts')) {
    ctx.fillStyle = '#2a5f8a';
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(side * r * 0.98, r * 0.1, r * 0.1, 0, Math.PI * 2); ctx.fill(); }
  }
  if (features.includes('dimples') && e.smile > 0.3) {
    ctx.fillStyle = character.blush;
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(side * r * 0.42 + turn * r * 0.1, r * 0.42, r * 0.03, 0, Math.PI * 2); ctx.fill(); }
  }
}

// Draws one frame. `expression` may be raw (yaw/pitch in degrees) or personalised (turn/nod in -1..1).
export function drawAvatar(ctx, character, expression, size, { background = true } = {}) {
  const e = { ...expression };
  if (typeof e.turn !== 'number') e.turn = clamp(e.yaw / 30, -1, 1);
  if (typeof e.nod !== 'number') e.nod = clamp(e.pitch / 20, -1, 1);
  const turn = clamp(e.turn, -1, 1);
  const nod = clamp(e.nod, -1, 1);
  ctx.save();
  ctx.clearRect(0, 0, size, size);
  if (background) {
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, character.bg[0]);
    gradient.addColorStop(1, character.bg[1]);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const r = size * 0.26;
  // Head follows the face across the frame (dampened) and rolls with it.
  const cx = size * (0.5 + (e.x - 0.5) * 0.35);
  const cy = size * (0.5 + (e.y - 0.5) * 0.25) + nod * -size * 0.02;
  ctx.translate(cx, cy);
  ctx.rotate((clamp(e.roll, -30, 30) * Math.PI) / 180);
  // 2.5-D turn: squash the head horizontally and slide the features toward the turn.
  ctx.scale(1 - Math.abs(turn) * 0.12, 1);
  // Shoulders.
  ctx.fillStyle = 'rgba(0,0,0,.14)';
  ctx.beginPath(); ctx.ellipse(0, r * 1.75, r * 1.5, r * 0.6, 0, Math.PI, Math.PI * 2); ctx.fill();
  drawHair(ctx, character, r, turn);
  // Head.
  ctx.fillStyle = character.skin;
  headPath(ctx, character.shape, r);
  ctx.fill();
  // Fringe for hairstyles that sit on the forehead.
  if (character.hairStyle === 'curls') {
    ctx.fillStyle = character.hair;
    for (let i = -2; i <= 2; i += 1) { ctx.beginPath(); ctx.arc(i * r * 0.36 + turn * r * 0.15, -r * 0.7, r * 0.22, 0, Math.PI * 2); ctx.fill(); }
  }
  const fx = turn * r * 0.28;
  const fy = nod * -r * 0.1;
  // Cheeks.
  ctx.fillStyle = character.blush;
  ctx.globalAlpha = 0.55 + clamp(e.smile, 0, 1) * 0.35 + clamp(e.cheekPuff, 0, 1) * 0.3;
  for (const side of [-1, 1]) { ctx.beginPath(); ctx.ellipse(side * r * 0.55 + fx, r * 0.25 + fy, r * 0.15 * (1 + e.cheekPuff * 0.5), r * 0.09 * (1 + e.cheekPuff * 0.5), 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
  // Brows.
  ctx.strokeStyle = character.hairStyle === 'ears' || character.hairStyle === 'sprout' ? character.eyes : character.hair;
  ctx.lineWidth = r * 0.06; ctx.lineCap = 'round';
  const browLift = e.browUp * r * 0.12 - e.browDown * r * 0.06;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * r * 0.52 + fx, -r * 0.36 + fy - browLift * 0.6);
    ctx.quadraticCurveTo(side * r * 0.32 + fx, -r * 0.46 + fy - browLift, side * r * 0.14 + fx, -r * 0.36 + fy - browLift * 0.3 + e.browDown * r * 0.05);
    ctx.stroke();
  }
  // Eyes (the left eye is the viewer's left; blink channels are already mirrored by the expression mapper).
  drawEye(ctx, character, -r * 0.34 + fx, -r * 0.1 + fy, r, e.blinkLeft, e.eyeWide, e.gazeX, e.gazeY);
  drawEye(ctx, character, r * 0.34 + fx, -r * 0.1 + fy, r, e.blinkRight, e.eyeWide, e.gazeX, e.gazeY);
  ctx.save();
  ctx.translate(fx * 0.9, fy * 0.6);
  drawMouth(ctx, character, r, e);
  ctx.restore();
  drawFeatures(ctx, character, r, e, turn);
  ctx.restore();
}
