import { useState } from 'react';
import { BatteryCharging, Bell, Camera, Mic, ShieldCheck } from 'lucide-react';
import { nativeRequestBatteryExemption, nativeRequestStartupPermissions, nativeShell, nativeStartBackground } from '../native.js';
import { requestNotificationPermission } from '../notify.js';

import { PERMISSIONS_ASKED_KEY } from '../permissionsKey.js';

export { PERMISSIONS_ASKED_KEY };

// Browsers only show the microphone/camera prompt when media is requested; the tracks are stopped at once.
async function requestWebMedia() {
  if (!navigator.mediaDevices?.getUserMedia) return false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach((track) => track.stop());
    return true;
  } catch {
    return false;
  }
}

// First-launch explainer, like a messenger's onboarding: say why, then let the system ask.
export default function PermissionsSheet({ onDone }) {
  const native = nativeShell();
  const [step, setStep] = useState('intro');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  async function allow() {
    setBusy(true);
    try {
      if (native) {
        const state = await nativeRequestStartupPermissions();
        await nativeStartBackground();
        setResult(state);
        setStep(state && !state.batteryUnrestricted ? 'battery' : 'done');
      } else {
        const notifications = await requestNotificationPermission();
        const media = await requestWebMedia();
        setResult({ notificationsEnabled: notifications === 'granted', microphone: media, camera: media });
        setStep('done');
      }
    } finally {
      setBusy(false);
    }
  }

  async function allowBattery() {
    setBusy(true);
    try {
      setResult((await nativeRequestBatteryExemption()) ?? result);
      setStep('done');
    } finally {
      setBusy(false);
    }
  }

  const finish = () => {
    try { localStorage.setItem(PERMISSIONS_ASKED_KEY, '1'); } catch { /* private mode */ }
    onDone?.();
  };
  const mark = (ok) => (ok ? 'Allowed' : 'Not allowed — change it in Settings');

  return (
    <div className="permissions-overlay" role="dialog" aria-modal="true" aria-labelledby="permissions-title">
      <div className="permissions-sheet">
        <ShieldCheck size={40} className="permissions-hero" aria-hidden="true" />
        <h2 id="permissions-title">{step === 'battery' ? 'Stay connected in the background' : 'Allow Hidden Messenger to…'}</h2>
        {step === 'intro' && <>
          <ul className="permissions-list">
            <li><Bell size={22} /><span><strong>Send notifications</strong><small>Separate sounds for chats, groups and ringing calls, with Accept / Reject on calls.</small></span></li>
            <li><Mic size={22} /><span><strong>Use the microphone</strong><small>Voice calls and voice messages.</small></span></li>
            <li><Camera size={22} /><span><strong>Use the camera</strong><small>Video calls and photos.</small></span></li>
            {native && <li><BatteryCharging size={22} /><span><strong>Keep a background connection</strong><small>A quiet “Connected” notification keeps messages and calls arriving while the app is closed to the background.</small></span></li>}
          </ul>
          <div className="permissions-actions">
            <button type="button" className="permissions-secondary" onClick={finish} disabled={busy}>Not now</button>
            <button type="button" className="permissions-primary" onClick={allow} disabled={busy}>{busy ? 'One moment…' : 'Continue'}</button>
          </div>
        </>}
        {step === 'battery' && <>
          <p className="permissions-copy">Android may stop apps in the background to save battery. Allowing Hidden Messenger to run without battery restrictions keeps calls ringing on time.</p>
          <div className="permissions-actions">
            <button type="button" className="permissions-secondary" onClick={() => setStep('done')} disabled={busy}>Skip</button>
            <button type="button" className="permissions-primary" onClick={allowBattery} disabled={busy}>Allow</button>
          </div>
        </>}
        {step === 'done' && <>
          <ul className="permissions-list is-result">
            <li><Bell size={20} /><span><strong>Notifications</strong><small>{mark(result?.notificationsEnabled)}</small></span></li>
            <li><Mic size={20} /><span><strong>Microphone</strong><small>{mark(result?.microphone)}</small></span></li>
            <li><Camera size={20} /><span><strong>Camera</strong><small>{mark(result?.camera)}</small></span></li>
            {native && <li><BatteryCharging size={20} /><span><strong>Background activity</strong><small>{result?.batteryUnrestricted ? 'Unrestricted' : 'Battery optimised — calls may be delayed'}</small></span></li>}
          </ul>
          <div className="permissions-actions">
            <button type="button" className="permissions-primary" onClick={finish}>Done</button>
          </div>
        </>}
      </div>
    </div>
  );
}
