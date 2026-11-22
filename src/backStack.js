// Android Back: screens that can be closed register here (newest on top). Back closes the topmost one; with
// nothing left, the app goes to the background like WhatsApp instead of quitting.
import { useEffect, useRef } from 'react';

const stack = [];
const listeners = new Set();
const changed = () => { for (const listener of listeners) listener(stack.length); };

/** How many closable screens are open, and a subscription to changes (returns the unsubscribe). */
export const backStackDepth = () => stack.length;
export function onBackStackChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBackHandler(active, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!active) return undefined;
    const entry = { run: () => ref.current?.() };
    stack.push(entry);
    changed();
    return () => {
      const index = stack.lastIndexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      changed();
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
