// Call screen state in isolated slices, like WhatsApp's per-region ViewModels / state holders (CallHeaderStateHolder,
// InCallBannerViewModelV2, the control card): each part of the call screen subscribes to its own slice only, so a
// change in one region never redraws the others — and nothing redraws every second (the timer keeps its own tick).
//
// CallOverlay owns the call (engines, signaling, media) and publishes plain values into these slices; the parts
// read them with useCallSlice(name). User actions go back through `actions`, a stable object the overlay refreshes.
import { create } from 'zustand';
import { EMPTY_NOTICES, nextNotice, pushNotice } from './noticeQueue.js';

const INITIAL = {
  // Title, status line inputs (the timer derives the text) and the header buttons.
  header: { title: '', status: 'idle', direction: 'outgoing', mode: 'audio', isOnline: true, answered: false, group: false, connectedAt: 0, networkQuality: 'good', terminal: false, incomingRinging: false, canAdd: false, addTitle: '' },
  // Everything the bottom control card shows.
  controls: { mode: 'audio', status: 'idle', terminal: false, incomingRinging: false, muted: false, cameraOff: false, speakerOn: false, nativeRouting: false, speakerLabel: '', moreOpen: false, videoRequest: null, screenSharing: false, canShareScreen: false, avatarOn: false, hasPersona: false },
  // In-call notices, one at a time by priority.
  notices: EMPTY_NOTICES,
};

function shallowEqual(a, b) {
  if (a === b) return true;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.is(a[key], b[key]));
}

export const useCallStore = create((set, get) => ({
  ...INITIAL,
  actions: {},

  /** Replaces a slice only when a value actually changed, so its subscribers stay quiet otherwise. */
  publish(name, next) {
    const current = get()[name];
    const merged = { ...current, ...next };
    if (!shallowEqual(current, merged)) set({ [name]: merged });
  },

  setActions(actions) {
    set({ actions });
  },

  notify(text, options) {
    set((state) => ({ notices: pushNotice(state.notices, text, options) }));
  },

  dismissNotice(id) {
    set((state) => ({ notices: nextNotice(state.notices, id) }));
  },

  /** A new call starts from a clean screen. */
  reset() {
    set({ ...INITIAL, actions: {} });
  },
}));

/** One slice of the call screen; the component re-renders only when that slice changes. */
export function useCallSlice(name) {
  return useCallStore((state) => state[name]);
}

/** A stable way to call an overlay action from a part of the call screen. */
export function callAction(name, ...args) {
  return useCallStore.getState().actions[name]?.(...args);
}
