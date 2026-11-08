// Fifteen original cartoon characters — five men, five women and five fun creatures — and the canvas renderer
// that animates them from an expression state.
// Everything is procedural (no image assets), so it draws at any size and ships with no downloads.

// Human characters share the 'human' head (ears, neck, clothes); hair is drawn in two layers (behind the head
// and over the forehead) and facial hair, lashes, lipstick, earrings and the hijab are features.
const HUMANS = [
  { id: 'rahim', group: 'male', name: 'Rahim', tagline: 'Neat hair, trimmed beard', shape: 'human', skin: '#c68a5e', blush: '#d9876a', hair: '#1d1714', hairStyle: 'short', eyes: '#2a1a12', shirt: '#1f8a7a', bg: ['#d8f3ee', '#7fc8b9'], features: ['beard', 'humanNose'] },
  { id: 'arif', group: 'male', name: 'Arif', tagline: 'Quiff and moustache', shape: 'human', skin: '#d9a27a', blush: '#e39a80', hair: '#2b1d16', hairStyle: 'quiff', eyes: '#3a2414', shirt: '#2d4f8f', bg: ['#dfe8ff', '#8aa7f0'], features: ['mustache', 'humanNose'] },
  { id: 'leo', group: 'male', name: 'Leo', tagline: 'Curly hair, light stubble', shape: 'human', skin: '#f2c7a5', blush: '#efa08c', hair: '#6b3f22', hairStyle: 'curlyShort', eyes: '#3c6e47', shirt: '#c0533b', bg: ['#ffe4d6', '#f39b7a'], features: ['stubble', 'humanNose'] },
  { id: 'kofi', group: 'male', name: 'Kofi', tagline: 'Buzz cut, full beard', shape: 'human', skin: '#8a5a3c', blush: '#a8664a', hair: '#141010', hairStyle: 'buzz', eyes: '#1d120c', shirt: '#e0a526', bg: ['#fff1cc', '#e7b54c'], features: ['fullBeard', 'humanNose'] },
  { id: 'kenji', group: 'male', name: 'Kenji', tagline: 'Side part and glasses', shape: 'human', skin: '#f0cfa8', blush: '#ecad94', hair: '#121212', hairStyle: 'sidePart', eyes: '#1e1712', shirt: '#5b5f6b', bg: ['#e9ecf2', '#a4adbf'], features: ['glasses', 'humanNose'] },
  { id: 'nadia', group: 'female', name: 'Nadia', tagline: 'Long hair and earrings', shape: 'human', skin: '#c98d64', blush: '#e08a7a', hair: '#1a1210', hairStyle: 'long', eyes: '#2a170e', lips: '#b8344f', shirt: '#8e3b8f', bg: ['#f6defa', '#c98ad6'], features: ['lashes', 'earrings', 'humanNose'] },
  { id: 'ayesha', group: 'female', name: 'Ayesha', tagline: 'Rose hijab', shape: 'human', skin: '#d7a07b', blush: '#e5937f', hair: '#c4577a', hairStyle: 'hijab', brows: '#2a1a12', eyes: '#2f1b10', lips: '#a8455a', shirt: '#c4577a', bg: ['#ffe3ec', '#ee9ab5'], features: ['lashes', 'humanNose'] },
  { id: 'mia', group: 'female', name: 'Mia', tagline: 'Blonde ponytail', shape: 'human', skin: '#f6d1b3', blush: '#f2a596', hair: '#e2b35a', hairStyle: 'ponytail', eyes: '#3e6fa8', lips: '#d0566b', shirt: '#3fa3d1', bg: ['#def4ff', '#82c9ef'], features: ['lashes', 'humanNose'] },
  { id: 'zara', group: 'female', name: 'Zara', tagline: 'Bob cut and glasses', shape: 'human', skin: '#a86b48', blush: '#c47a5e', hair: '#3a2219', hairStyle: 'bob', eyes: '#24140c', lips: '#8f2f45', shirt: '#2f9e5b', bg: ['#dcf7e6', '#7fd1a0'], features: ['lashes', 'glasses', 'humanNose'] },
  { id: 'priya', group: 'female', name: 'Priya', tagline: 'Bun and gold earrings', shape: 'human', skin: '#b9784f', blush: '#d0826a', hair: '#20140f', hairStyle: 'bun', eyes: '#2a170e', lips: '#a3304a', shirt: '#e0662f', bg: ['#ffe6d4', '#f2a173'], features: ['lashes', 'earrings', 'humanNose'] },
];

export const CHARACTER_GROUPS = Object.freeze([
  { id: 'male', label: 'Men' },
  { id: 'female', label: 'Women' },
  { id: 'fun', label: 'Fun characters' },
]);

export const CHARACTERS = Object.freeze([
  ...HUMANS,
  { id: 'sunny', group: 'fun', name: 'Sunny', tagline: 'Warm and freckled', shape: 'round', skin: '#f7c9a6', blush: '#f29e8e', hair: '#e2632b', hairStyle: 'curls', eyes: '#4b3a2f', bg: ['#ffd9a0', '#ff9a62'], features: ['freckles'] },
  { id: 'pixel', group: 'fun', name: 'Pixel', tagline: 'A friendly little robot', shape: 'square', skin: '#9fd4ff', blush: '#6fb6ff', hair: '#2a5f8a', hairStyle: 'antenna', eyes: '#0b2a45', bg: ['#dff3ff', '#6cb8ff'], features: ['visor', 'bolts'] },
  { id: 'momo', group: 'fun', name: 'Momo', tagline: 'Curious cat', shape: 'cat', skin: '#f3e3c8', blush: '#f1b2a4', hair: '#d9a86c', hairStyle: 'ears', eyes: '#2e7d4f', bg: ['#fff1d6', '#f6b26b'], features: ['whiskers', 'nose'] },
  { id: 'indigo', group: 'fun', name: 'Indigo', tagline: 'Cool, with glasses', shape: 'oval', skin: '#b79cf0', blush: '#9b7be6', hair: '#2b1b4f', hairStyle: 'mohawk', eyes: '#1b1240', bg: ['#e4dcff', '#8f6bff'], features: ['glasses'] },
  { id: 'bean', group: 'fun', name: 'Bean', tagline: 'Bouncy green blob', shape: 'blob', skin: '#9be27a', blush: '#6cc35a', hair: '#4f9a3a', hairStyle: 'sprout', eyes: '#173d12', bg: ['#e7ffd9', '#7fd66a'], features: ['dimples'] },
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
  } else if (shape === 'oval' || shape === 'human') {
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
    case 'short':
    case 'quiff':
    case 'sidePart':
    case 'buzz':
    case 'curlyShort':
      // Only the front layer; the back of a short cut is hidden by the head.
      break;
    case 'long':
      ctx.beginPath();
      ctx.ellipse(turn * r * 0.08, -r * 0.12, r * 1.08, r * 1.16, 0, Math.PI, Math.PI * 2);
      ctx.lineTo(r * 1.08 + turn * r * 0.08, r * 1.45);
      ctx.quadraticCurveTo(turn * r * 0.08, r * 1.65, -r * 1.08 + turn * r * 0.08, r * 1.45);
      ctx.closePath(); ctx.fill();
      break;
    case 'bob':
      ctx.beginPath();
      ctx.ellipse(turn * r * 0.08, -r * 0.1, r * 1.12, r * 1.14, 0, Math.PI, Math.PI * 2);
      ctx.lineTo(r * 1.12 + turn * r * 0.08, r * 0.62);
      ctx.quadraticCurveTo(turn * r * 0.08, r * 0.78, -r * 1.12 + turn * r * 0.08, r * 0.62);
      ctx.closePath(); ctx.fill();
      break;
    case 'ponytail':
      ctx.beginPath(); ctx.ellipse(turn * r * 0.08, -r * 0.2, r * 1.0, r * 1.02, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(r * 0.98 - turn * r * 0.2, r * 0.35, r * 0.24, r * 0.68, -0.25, 0, Math.PI * 2); ctx.fill();
      break;
    case 'bun':
      ctx.beginPath(); ctx.ellipse(turn * r * 0.08, -r * 0.2, r * 0.98, r * 1.0, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(turn * r * 0.12, -r * 1.2, r * 0.36, 0, Math.PI * 2); ctx.fill();
      break;
    case 'hijab':
      // Fabric framing the face and falling over the shoulders.
      ctx.beginPath();
      ctx.ellipse(turn * r * 0.06, -r * 0.02, r * 1.22, r * 1.32, 0, Math.PI, Math.PI * 2);
      ctx.lineTo(r * 1.5, r * 1.75);
      ctx.lineTo(-r * 1.5, r * 1.75);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,.08)';
      ctx.beginPath(); ctx.ellipse(turn * r * 0.06, r * 1.05, r * 0.9, r * 0.35, 0, 0, Math.PI); ctx.fill();
      ctx.fillStyle = character.hair;
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

// Neck and clothes under a human head.
function drawBody(ctx, character, r) {
  ctx.fillStyle = character.skin;
  ctx.fillRect(-r * 0.26, r * 0.7, r * 0.52, r * 0.7);
  ctx.fillStyle = 'rgba(0,0,0,.1)';
  ctx.fillRect(-r * 0.26, r * 0.7, r * 0.52, r * 0.22);
  ctx.fillStyle = character.shirt;
  ctx.beginPath();
  ctx.ellipse(0, r * 2.05, r * 1.55, r * 0.78, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  // Collar.
  ctx.fillStyle = character.skin;
  ctx.beginPath(); ctx.moveTo(-r * 0.26, r * 1.3); ctx.lineTo(0, r * 1.55); ctx.lineTo(r * 0.26, r * 1.3); ctx.closePath(); ctx.fill();
}

function drawEars(ctx, character, r, turn) {
  if (character.hairStyle === 'hijab') return;
  ctx.fillStyle = character.skin;
  for (const side of [-1, 1]) {
    // The ear on the side the head turns away from shrinks.
    const visible = 1 - Math.max(0, side * turn) * 0.7;
    ctx.beginPath(); ctx.ellipse(side * r * 0.86, -r * 0.02, r * 0.13 * visible, r * 0.2, 0, 0, Math.PI * 2); ctx.fill();
  }
}

// Hair that sits over the forehead, drawn after the head.
function drawHairFront(ctx, character, r, turn) {
  const t = turn * r * 0.15;
  ctx.fillStyle = character.hair;
  switch (character.hairStyle) {
    case 'short':
    case 'buzz':
    case 'quiff':
      if (character.hairStyle === 'buzz') ctx.globalAlpha = 0.85;
      ctx.beginPath();
      ctx.ellipse(t * 0.5, -r * 0.08, r * 0.92, r * 1.14, 0, Math.PI * 1.08, Math.PI * 1.92);
      ctx.quadraticCurveTo(r * 0.5 + t, -r * (character.hairStyle === 'buzz' ? 0.82 : 0.62), t, -r * (character.hairStyle === 'buzz' ? 0.86 : 0.7));
      ctx.quadraticCurveTo(-r * 0.5 + t, -r * (character.hairStyle === 'buzz' ? 0.82 : 0.62), -r * 0.86 + t * 0.5, -r * 0.48);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1;
      if (character.hairStyle === 'quiff') {
        ctx.beginPath(); ctx.ellipse(r * 0.12 + t, -r * 1.06, r * 0.58, r * 0.3, -0.22, 0, Math.PI * 2); ctx.fill();
      }
      break;
    case 'sidePart':
      ctx.beginPath();
      ctx.ellipse(t * 0.5, -r * 0.08, r * 0.93, r * 1.15, 0, Math.PI * 1.06, Math.PI * 1.94);
      ctx.quadraticCurveTo(r * 0.35 + t, -r * 0.78, -r * 0.25 + t, -r * 0.62);
      ctx.quadraticCurveTo(-r * 0.7 + t, -r * 0.5, -r * 0.88 + t * 0.5, -r * 0.4);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.18)'; ctx.lineWidth = r * 0.03;
      ctx.beginPath(); ctx.moveTo(r * 0.3 + t, -r * 1.12); ctx.lineTo(r * 0.36 + t, -r * 0.8); ctx.stroke();
      break;
    case 'curlyShort':
      for (let i = -4; i <= 4; i += 1) {
        ctx.beginPath();
        ctx.arc(i * r * 0.2 + t, -r * 0.95 + Math.abs(i) * r * 0.09, r * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 'long':
    case 'bob':
    case 'ponytail':
    case 'bun':
      // A side-swept fringe framing the face.
      ctx.beginPath();
      ctx.ellipse(t * 0.5, -r * 0.1, r * 0.94, r * 1.14, 0, Math.PI * 1.05, Math.PI * 1.95);
      ctx.quadraticCurveTo(r * 0.3 + t, -r * 0.62, -r * 0.2 + t, -r * 0.72);
      ctx.quadraticCurveTo(-r * 0.7 + t, -r * 0.6, -r * 0.9 + t * 0.5, -r * 0.1);
      ctx.closePath(); ctx.fill();
      break;
    case 'hijab':
      // The band over the forehead and around the face.
      ctx.beginPath();
      ctx.ellipse(t * 0.4, -r * 0.04, r * 1.0, r * 1.18, 0, Math.PI, Math.PI * 2);
      ctx.ellipse(t * 0.4, -r * 0.02, r * 0.8, r * 0.82, 0, Math.PI * 2, Math.PI, true);
      ctx.closePath(); ctx.fill();
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.ellipse(side * r * 0.9 + t * 0.4, r * 0.15, r * 0.16, r * 0.62, 0, 0, Math.PI * 2); ctx.fill();
      }
      break;
    default:
      break;
  }
}

// Beard, stubble and moustache sit under the mouth layer so speech stays visible; the beard drops with the jaw.
function drawFacialHair(ctx, character, r, e, fx, fy) {
  const features = character.features ?? [];
  const open = clamp(e.jawOpen, 0, 1);
  const mouthY = r * 0.45 + fy * 0.6;
  if (features.includes('beard') || features.includes('fullBeard') || features.includes('stubble')) {
    const full = features.includes('fullBeard');
    ctx.fillStyle = character.hair;
    ctx.globalAlpha = features.includes('stubble') ? 0.28 : 0.95;
    ctx.beginPath();
    ctx.ellipse(fx * 0.6, r * 0.18, r * 0.86, r * (full ? 0.98 : 0.9) + open * r * 0.12, 0, 0, Math.PI);
    ctx.ellipse(fx * 0.9, mouthY + r * 0.06 + open * r * 0.16, r * (full ? 0.3 : 0.36), r * (0.16 + open * 0.2), 0, Math.PI, 0, true);
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  }
  if (features.includes('mustache') || features.includes('beard') || features.includes('fullBeard')) {
    ctx.fillStyle = character.hair;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * r * 0.14 + fx * 0.9, mouthY - r * 0.1, r * 0.17, r * 0.07, side * 0.25, 0, Math.PI * 2);
      ctx.fill();
    }
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
  const lips = character.lips ?? '#5a1f2b';
  ctx.fillStyle = '#5a1f2b';
  ctx.beginPath();
  if (open > 0.08) {
    if (character.lips) {
      ctx.strokeStyle = lips; ctx.lineWidth = r * 0.05;
      ctx.ellipse(0, cy + height * 0.4, width * 0.55, height * 0.55, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
    }
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
    ctx.strokeStyle = lips; ctx.lineWidth = r * (character.lips ? 0.07 : 0.045); ctx.lineCap = 'round';
    ctx.moveTo(-width * 0.5, cy);
    ctx.quadraticCurveTo(0, cy + (smile * 0.35 - 0.05 + pucker * -0.1) * r, width * 0.5, cy);
    ctx.stroke();
  }
}

function drawFeatures(ctx, character, r, e, turn, fx = turn * r * 0.28, fy = 0) {
  const features = character.features ?? [];
  if (features.includes('humanNose')) {
    ctx.strokeStyle = 'rgba(90, 40, 20, .35)'; ctx.lineWidth = r * 0.035; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(fx * 1.1 - r * 0.02, r * 0.02 + fy); ctx.quadraticCurveTo(fx * 1.1 + r * 0.08, r * 0.2 + fy, fx * 1.1 - r * 0.05, r * 0.24 + fy); ctx.stroke();
  }
  if (features.includes('lashes')) {
    ctx.strokeStyle = '#1a1210'; ctx.lineWidth = r * 0.025; ctx.lineCap = 'round';
    const lift = r * (0.19 + e.eyeWide * 0.06);
    for (const [side, blink] of [[-1, e.blinkLeft], [1, e.blinkRight]]) {
      const cx = side * r * 0.34 + fx;
      const cy = -r * 0.1 + fy - lift * (1 - clamp(blink, 0, 1) * 0.92);
      for (const dx of [-0.12, 0, 0.12]) {
        ctx.beginPath(); ctx.moveTo(cx + dx * r + side * r * 0.04, cy); ctx.lineTo(cx + dx * r * 1.3 + side * r * 0.07, cy - r * 0.07); ctx.stroke();
      }
    }
  }
  if (features.includes('earrings')) {
    ctx.fillStyle = '#e7b93a';
    for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(side * r * 0.88 + turn * r * 0.1, r * 0.24, r * 0.06, 0, Math.PI * 2); ctx.fill(); }
  }
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
  const human = character.shape === 'human';
  if (human) {
    drawBody(ctx, character, r);
  } else {
    // Shoulders.
    ctx.fillStyle = 'rgba(0,0,0,.14)';
    ctx.beginPath(); ctx.ellipse(0, r * 1.75, r * 1.5, r * 0.6, 0, Math.PI, Math.PI * 2); ctx.fill();
  }
  drawHair(ctx, character, r, turn);
  if (human) drawEars(ctx, character, r, turn);
  // Head.
  ctx.fillStyle = character.skin;
  headPath(ctx, character.shape, r);
  ctx.fill();
  if (human) drawHairFront(ctx, character, r, turn);
  // Fringe for hairstyles that sit on the forehead.
  if (character.hairStyle === 'curls') {
    ctx.fillStyle = character.hair;
    for (let i = -2; i <= 2; i += 1) { ctx.beginPath(); ctx.arc(i * r * 0.36 + turn * r * 0.15, -r * 0.7, r * 0.22, 0, Math.PI * 2); ctx.fill(); }
  }
  const fx = turn * r * 0.28;
  const fy = nod * -r * 0.1;
  // Cheeks.
  ctx.fillStyle = character.blush;
  ctx.globalAlpha = (human ? 0.25 : 0.55) + clamp(e.smile, 0, 1) * 0.35 + clamp(e.cheekPuff, 0, 1) * 0.3;
  for (const side of [-1, 1]) { ctx.beginPath(); ctx.ellipse(side * r * 0.55 + fx, r * 0.25 + fy, r * 0.15 * (1 + e.cheekPuff * 0.5), r * 0.09 * (1 + e.cheekPuff * 0.5), 0, 0, Math.PI * 2); ctx.fill(); }
  ctx.globalAlpha = 1;
  // Brows.
  ctx.strokeStyle = character.brows ?? (character.hairStyle === 'ears' || character.hairStyle === 'sprout' ? character.eyes : character.hair);
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
  if (human) drawFacialHair(ctx, character, r, e, fx, fy);
  ctx.save();
  ctx.translate(fx * 0.9, fy * 0.6);
  drawMouth(ctx, character, r, e);
  ctx.restore();
  drawFeatures(ctx, character, r, e, turn, fx, fy);
  ctx.restore();
}
