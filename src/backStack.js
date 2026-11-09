// Android Back: screens that can be closed register here (newest on top). Back closes the topmost one; with
// nothing left, the app goes to the background like WhatsApp instead of quitting.
import { useEffect, useRef } from 'react';

const stack = [];

export function useBackHandler(active, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return undefined;
    const entry = { run: () => ref.current?.() };
    stack.push(entry);
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [active]);
}

// Returns true when a screen handled Back.
export function handleBack() {
  const top = stack.at(-1);
  if (!top) return false;
  top.run();
  return true;
}

export function backStackDepthForTests() {
  return stack.length;
}
