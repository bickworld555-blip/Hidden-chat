// Screens that are not needed to show the chat list load as separate chunks, so the app starts faster. Each
// comes with its own invisible Suspense boundary (nothing else on screen blanks while it loads), and once the
// app is up and idle every chunk is fetched in the background so opening them later is still instant.
import { Suspense, createElement, lazy } from 'react';

const loaders = [];

export function lazyComponent(factory, pick = (module) => module.default) {
  let promise = null;
  const load = () => {
    promise ??= factory().then((module) => ({ default: pick(module) })).catch((error) => { promise = null; throw error; });
    return promise;
  };
  const Lazy = lazy(load);
  function LazyScreen(props) {
    return createElement(Suspense, { fallback: null }, createElement(Lazy, props));
  }
  LazyScreen.preload = load;
  loaders.push(load);
  return LazyScreen;
}

const PRELOAD_AFTER_MS = 3000;
let preloadScheduled = false;
export function preloadLazyScreens() {
  if (preloadScheduled) return;
  preloadScheduled = true;
  const run = () => { for (const load of loaders) load().catch(() => {}); };
  // After the chat list has drawn: on a cold start the first idle moment could fall while the list was still being
  // built, and compiling some 40 screens then held it back (S23, 2026-11-22). A screen opened sooner loads on demand.
  setTimeout(() => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 4000 });
    else run();
  }, PRELOAD_AFTER_MS);
}
