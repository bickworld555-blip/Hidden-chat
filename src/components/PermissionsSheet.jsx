import { Bell } from 'lucide-react';
import { requestNotificationPermission } from '../notify.js';
import { PERMISSIONS_ASKED_KEY, permissionsAskedKey } from '../permissionsKey.js';
import { deviceStorage } from '../deviceStorage.js';

export { PERMISSIONS_ASKED_KEY };

// Browsers only (the Android app uses Android's own notification prompt): one question, for notifications.
// Microphone, camera and location are asked by the browser when a call, voice note or location share needs them.
export default function PermissionsSheet({ onDone }) {
  const finish = () => {
    try { deviceStorage.setItem(permissionsAskedKey(), '1'); } catch { /* private mode */ }
    onDone?.();
  };
  const allow = async () => {
    await requestNotificationPermission();
    finish();
  };

  return (
    <div className="permissions-overlay" role="dialog" aria-modal="true" aria-labelledby="permissions-title">
      <div className="permissions-sheet">
        <Bell size={40} className="permissions-hero" aria-hidden="true" />
        <h2 id="permissions-title">Get notified of new messages</h2>
        <p className="permissions-copy">Hidden Messenger can tell you about new messages and ringing calls while this tab is in the background.</p>
        <div className="permissions-actions">
          <button type="button" className="permissions-secondary" onClick={finish}>Not now</button>
          <button type="button" className="permissions-primary" onClick={allow}>Turn on</button>
        </div>
      </div>
    </div>
  );
}
