// The status ring around a contact's photo (as on WhatsApp): blue while they have an update I haven't seen, grey once
// I've seen them all, none when they have none (expired after 24 hours). Tapping a ringed photo opens their status
// instead of whatever the row does; `canOpen()` can veto it (selection mode, the end of a long press).
import { useChatStore } from '../store.js';

export function useStatusRing(userId) {
  return useChatStore((state) => (userId ? state.statusRings?.[userId] : undefined));
}

export function statusRingProps(userId, ring, name, canOpen = () => true) {
  if (!ring) return {};
  return {
    'data-status': ring,
    title: `View ${name || 'their'} status`,
    onClick: (event) => {
      if (!canOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      useChatStore.getState().openStatusOf(userId);
    },
  };
}

export default function StatusRing({ userId, name, children, canOpen }) {
  const ring = useStatusRing(userId);
  return (
    <span className={`status-ring-wrap${ring ? ` has-status status-${ring}` : ''}`} {...statusRingProps(userId, ring, name, canOpen)}>
      {children}
    </span>
  );
}
