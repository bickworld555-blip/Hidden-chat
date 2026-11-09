import { useEffect, useState } from 'react';
import { PhoneIncoming, PictureInPicture2 } from 'lucide-react';
import { nativeOpenCallSettings, nativeState } from '../native.js';
import { CALL_ACCESS_ASKED_KEY, missingCallAccess } from '../callAccess.js';

// Android app only. Two system switches decide whether calls work like WhatsApp's: ringing calls full screen on
// the lock screen (Android 14+ turns it off for apps installed outside the Play Store) and the floating video
// window (some phones ship with it off). Each opens the exact settings page; the sheet re-checks on return.
export default function CallAccessSheet({ initial, onDone }) {
  const [missing, setMissing] = useState(() => missingCallAccess(initial));

  useEffect(() => {
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      const next = missingCallAccess(await nativeState());
      setMissing(next);
      if (next.length === 0) finish();
    };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  });

  function finish() {
    try { localStorage.setItem(CALL_ACCESS_ASKED_KEY, '1'); } catch { /* private mode */ }
    onDone?.();
  }

  return (
    <div className="permissions-overlay" role="dialog" aria-modal="true" aria-labelledby="call-access-title">
      <div className="permissions-sheet">
        <PhoneIncoming size={40} className="permissions-hero" aria-hidden="true" />
        <h2 id="call-access-title">Calls on this phone</h2>
        <p className="permissions-copy">Android is blocking these for Hidden Messenger. Tap each one and switch it on.</p>
        <ul className="permissions-list">
          {missing.includes('fullScreen') && (
            <li>
              <PhoneIncoming size={22} />
              <span><strong>Show calls on the lock screen</strong><small>Ringing calls light up the screen with Accept / Decline, even when the phone is locked.</small></span>
              <button type="button" className="permissions-primary call-access-open" onClick={() => nativeOpenCallSettings('fullScreen')}>Allow</button>
            </li>
          )}
          {missing.includes('pictureInPicture') && (
            <li>
              <PictureInPicture2 size={22} />
              <span><strong>Picture-in-picture</strong><small>A video call keeps playing in a small floating window when you leave the app.</small></span>
              <button type="button" className="permissions-primary call-access-open" onClick={() => nativeOpenCallSettings('pictureInPicture')}>Allow</button>
            </li>
          )}
        </ul>
        <div className="permissions-actions">
          <button type="button" className="permissions-secondary" onClick={finish}>Later</button>
        </div>
      </div>
    </div>
  );
}
