import { useEffect, useState } from 'react';
import { BatteryCharging, Moon, PhoneIncoming, PictureInPicture2, Rocket } from 'lucide-react';
import { nativeOpenCallSettings, nativeShell, nativeState } from '../native.js';
import { MANUAL_CALL_ACCESS, autostartHint, missingCallAccess, readConfirmed, saveConfirmed } from '../callAccess.js';

// Android app only: "Make calls ring", a numbered guide in the Calls tab (never a popup). Each step opens the exact
// settings page; steps the app can check disappear once fixed, and the two the phone makers keep unreadable
// (Autostart, Samsung's Sleeping apps) disappear when the person taps "Done". WhatsApp and Telegram ask for the same
// switches: without them some phones hold back the push that rings an incoming call while the app is closed.
const COPY = {
  battery: [BatteryCharging, 'Let calls wake the app', 'Battery optimization can delay incoming calls. Tap, then Battery › Unrestricted.'],
  autostart: [Rocket, 'Allow Autostart', null],
  sleeping: [Moon, 'Keep the app awake', 'Battery › Background usage limits › Never sleeping apps: add Hidden Messenger.'],
  fullScreen: [PhoneIncoming, 'Ring full screen on the lock screen', 'Off in Android for this app. Tap to turn it on.'],
  pictureInPicture: [PictureInPicture2, 'Floating video window', 'Off in Android for this app. Tap to turn it on.'],
};

export default function CallAccessNotice() {
  const [state, setState] = useState(null);
  const [confirmed, setConfirmed] = useState(() => readConfirmed());
  const [opened, setOpened] = useState([]);

  useEffect(() => {
    if (!nativeShell()) return undefined;
    let live = true;
    const refresh = async () => {
      if (document.visibilityState !== 'visible') return;
      const next = await nativeState().catch(() => null);
      if (live) setState(next);
    };
    refresh();
    document.addEventListener('visibilitychange', refresh);
    return () => { live = false; document.removeEventListener('visibilitychange', refresh); };
  }, []);

  const missing = missingCallAccess(state, confirmed);
  if (missing.length === 0) return null;
  const open = (which) => {
    nativeOpenCallSettings(which);
    setOpened((current) => [...new Set([...current, which])]);
  };
  const confirm = (which) => {
    const next = [...confirmed, which];
    saveConfirmed(next);
    setConfirmed(next);
  };
  return (
    <section className="call-access-notices" aria-label="Make calls ring">
      <p className="call-access-title"><strong>Make calls ring</strong><small>{missing.length === 1 ? '1 step' : `${missing.length} steps`} so calls reach you when the app is closed</small></p>
      <ol>
        {missing.map((which) => {
          const [Icon, title, detail] = COPY[which];
          const manual = MANUAL_CALL_ACCESS.includes(which);
          return (
            <li key={which} className="call-access-step">
              <button type="button" className="call-access-notice" onClick={() => open(which)}>
                <Icon size={20} aria-hidden="true" />
                <span><strong>{title}</strong><small>{which === 'autostart' ? autostartHint(state?.maker) : detail}</small></span>
              </button>
              {manual && opened.includes(which) && <button type="button" className="call-access-done" onClick={() => confirm(which)}>Done</button>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
