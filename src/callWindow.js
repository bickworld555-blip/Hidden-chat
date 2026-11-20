// Where the minimised call window settles after a drag (src/components/CallOverlay.jsx). Like Android's own floating
// window (seen with WhatsApp's video call on the S23, 2026-11-21: always 45 px from the left or right edge, at any
// height), it goes to the nearer side, or the side it was flung towards, and stays at the height it was left.

// A quick sideways throw (px per ms) picks its side whatever the window's position.
export const PIP_FLING_SPEED = 0.6;
const MARGIN = 12;
// Clear of the call's top bar and of the bottom controls.
const TOP_CLEARANCE = 64;
const BOTTOM_CLEARANCE = 84;

export function pipSnap(rect, velocityX, viewport, safeTop = 0) {
  const flung = Math.abs(velocityX || 0) >= PIP_FLING_SPEED;
  const left = flung ? velocityX < 0 : rect.left + rect.width / 2 < viewport.width / 2;
  const topLimit = safeTop + TOP_CLEARANCE;
  const bottomLimit = Math.max(topLimit, viewport.height - rect.height - BOTTOM_CLEARANCE);
  return {
    x: left ? MARGIN : Math.max(MARGIN, viewport.width - rect.width - MARGIN),
    y: Math.min(bottomLimit, Math.max(topLimit, rect.top)),
  };
}
