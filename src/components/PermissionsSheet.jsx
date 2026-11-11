import { useState } from 'react';
import { Bell, Bluetooth, Camera, ContactRound, History, Image, MapPin, MessageSquare, Mic, Phone, ShieldCheck } from 'lucide-react';
import { nativeRequestStartupPermissions, nativeShell, nativeStartBackground } from '../native.js';
import { requestNotificationPermission } from '../notify.js';

import { PERMISSIONS_ASKED_KEY, permissionsAskedKey } from '../permissionsKey.js';

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

// What the phone app asks for at first launch, and what each one is for. "Not used yet" is said plainly: those
// are asked so the set matches other messengers, and declining them changes nothing.
const NATIVE_ITEMS = [
  ['notificationsEnabled', Bell, 'Notifications', 'Separate sounds for chats, groups and ringing calls, with Accept / Reject on calls.'],
  ['contacts', ContactRound, 'Contacts', 'Pick someone to invite (Tools › Invite a friend). Your contacts stay on this phone and are never uploaded.'],
  ['sms', MessageSquare, 'SMS', 'Text an invite to the person you pick, from your phone. Nothing is sent unless you tap Text.'],
  ['microphone', Mic, 'Microphone', 'Voice calls, video calls and voice messages.'],
  ['camera', Camera, 'Camera', 'Video calls, photos, video notes and scanning QR codes to link a computer.'],
  ['media', Image, 'Photos, videos and music', 'Not used yet: you choose files with the system picker. You can say no.'],
  ['location', MapPin, 'Location', 'Only when you share your location in a chat.'],
  ['nearby', Bluetooth, 'Nearby devices', 'Not used yet (Bluetooth headsets already work for calls). You can say no.'],
  ['phone', Phone, 'Phone', 'Not used yet: Hidden Messenger has no phone numbers. You can say no.'],
  ['callLog', History, 'Call log', 'Not used yet: your phone’s call history is never read. You can say no.'],
];
const WEB_ITEMS = NATIVE_ITEMS.filter(([key]) => ['notificationsEnabled', 'microphone', 'camera'].includes(key));

// First-launch explainer, like a messenger's onboarding: say why, then let the system ask.
export default function PermissionsSheet({ onDone }) {
  const native = nativeShell();
  const items = native ? NATIVE_ITEMS : WEB_ITEMS;
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
        setStep('done');
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

  const finish = () => {
    try { localStorage.setItem(permissionsAskedKey(), '1'); } catch { /* private mode */ }
    onDone?.();
  };
  const mark = (ok) => (ok ? 'Allowed' : 'Not allowed — change it in Settings');

  return (
    <div className="permissions-overlay" role="dialog" aria-modal="true" aria-labelledby="permissions-title">
      <div className="permissions-sheet">
        <ShieldCheck size={40} className="permissions-hero" aria-hidden="true" />
        <h2 id="permissions-title">Allow Hidden Messenger to…</h2>
        {step === 'intro' && <>
          <ul className="permissions-list">
            {items.map(([key, Icon, title, detail]) => <li key={key}><Icon size={22} /><span><strong>{title}</strong><small>{detail}</small></span></li>)}
          </ul>
          <p className="permissions-note">Android asks about each one in turn. Say no to any of them; features that need one ask again when you use them.</p>
          <div className="permissions-actions">
            <button type="button" className="permissions-secondary" onClick={finish} disabled={busy}>Not now</button>
            <button type="button" className="permissions-primary" onClick={allow} disabled={busy}>{busy ? 'One moment…' : 'Continue'}</button>
          </div>
        </>}
        {step === 'done' && <>
          <ul className="permissions-list is-result">
            {items.filter(([key]) => typeof result?.[key] === 'boolean').map(([key, Icon, title]) => <li key={key}><Icon size={20} /><span><strong>{title}</strong><small>{mark(result[key])}</small></span></li>)}
          </ul>
          <div className="permissions-actions">
            <button type="button" className="permissions-primary" onClick={finish}>Done</button>
          </div>
        </>}
      </div>
    </div>
  );
}
