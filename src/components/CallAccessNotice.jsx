import { useEffect, useState } from 'react';
import { PhoneIncoming, PictureInPicture2 } from 'lucide-react';
import { nativeOpenCallSettings, nativeShell, nativeState } from '../native.js';
import { missingCallAccess } from '../callAccess.js';

// Android app only, a quiet row in the Calls tab (never a popup). Calls always ring through Android's call system;
// these two switches only add the full-screen ring on the lock screen (Android 14+ keeps it off for apps installed
// outside the Play Store) and the floating video window. The row opens the exact settings page and disappears
// once the switch is on.
const COPY = {
  fullScreen: [PhoneIncoming, 'Ring full screen on the lock screen', 'Off in Android for this app. Tap to turn it on.'],
  pictureInPicture: [PictureInPicture2, 'Floating video window', 'Off in Android for this app. Tap to turn it on.'],
};

export default function CallAccessNotice() {
  const [missing, setMissing] = useState([]);

  useEffect(() => {
    if (!nativeShell()) return undefined;
    let live = true;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      const state = await nativeState().catch(() => null);
      if (live) setMissing(missingCallAccess(state));
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => { live = false; document.removeEventListener('visibilitychange', refresh); };
  }, []);

  if (missing.length === 0) return null;
  return (
    <div className="call-access-notices">
      {missing.map((which) => {
        const [Icon, title, detail] = COPY[which];
        return (
          <button key={which} type="button" className="call-access-notice" onClick={() => nativeOpenCallSettings(which)}>
            <Icon size={20} aria-hidden="true" />
            <span><strong>{title}</strong><small>{detail}</small></span>
          </button>
        );
      })}
    </div>
  );
}
