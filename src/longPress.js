// Long-press recognition on top of pointer events: one code path for touch, pen and mouse, cancelled by
// movement (scrolling), by lifting early, or by another pointer. Right-click reports as a long press too.

export const LONG_PRESS_MS = 450;
export const LONG_PRESS_SLOP_PX = 10;

export function createLongPress(onLongPress, { delay = LONG_PRESS_MS, slop = LONG_PRESS_SLOP_PX, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let timer = null;
  let pointerId = null;
  let origin = null;
  let fired = false;

  function reset() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    pointerId = null;
    origin = null;
  }

  return {
    // True right after a long press, so the click that follows the release can be ignored once.
    consumeFired() {
      const was = fired;
      fired = false;
      return was;
    },
    // The same, without using it up (for a handler that lets the click pass on to one that consumes it).
    wasFired: () => fired,
    cancel: reset,
    onPointerDown(event) {
      // Every new press starts fresh, a right-click included: otherwise a second right-click (with no left click in
      // between) would be taken for the contextmenu of the previous long press and ignored.
      fired = false;
      if (event.button !== undefined && event.button !== 0) return;
      reset();
      pointerId = event.pointerId ?? null;
      origin = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
      timer = setTimer(() => {
        timer = null;
        fired = true;
        onLongPress(event);
      }, delay);
    },
    onPointerMove(event) {
      if (timer === null || !origin) return;
      if (pointerId !== null && event.pointerId !== undefined && event.pointerId !== pointerId) return;
      const dx = (event.clientX ?? 0) - origin.x;
      const dy = (event.clientY ?? 0) - origin.y;
      if (Math.hypot(dx, dy) > slop) reset();
    },
    onPointerUp: reset,
    onPointerCancel: reset,
    onPointerLeave: reset,
    onContextMenu(event) {
      event.preventDefault?.();
      // A touch long-press raises contextmenu after the timer already fired; never report it twice.
      if (fired) return;
      reset();
      fired = true;
      onLongPress(event);
    },
  };
}
