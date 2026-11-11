// Linked devices with a QR code, like web.whatsapp.com:
//   LinkWithPhone  (browser, signed out) shows a QR and a short code and waits for the phone.
//   LinkScanner    (phone, signed in) scans the QR (or takes the code), confirms, links, and sends recent chats.
import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Camera, Keyboard, Laptop, Lock, RefreshCw } from 'lucide-react';
import jsQR from 'jsqr';
import { approveLink, lookupLink, parseLinkQr, recentSnapshot, rememberPendingHistory, startLink, waitForApproval } from '../linking.js';
import { buildBackupData } from '../backup.js';
import { useChatStore } from '../store.js';

export function LinkWithPhone({ onAuthenticated }) {
  const [link, setLink] = useState(null);
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let current = null;
    setLink(null);
    setError('');
    startLink()
      .then((created) => {
        current = created;
        setLink(created);
        return waitForApproval(created, { signal: controller.signal });
      })
      .then((session) => {
        rememberPendingHistory(current);
        onAuthenticated(session);
      })
      .catch((caught) => {
        if (caught?.name === 'AbortError') return;
        setError(caught?.status === 404 ? 'This QR code expired.' : caught?.message || 'Linking failed.');
      });
    return () => controller.abort();
  }, [round]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="link-phone">
      <ol className="link-steps">
        <li>Open Hidden Messenger on your phone</li>
        <li>Tap <strong>⋮ › Settings › Account › Linked devices</strong></li>
        <li>Tap <strong>Link a device</strong> and point your phone at this screen</li>
      </ol>
      <div className="link-qr" aria-live="polite">
        {link && !error ? <QRCodeSVG value={link.qr} size={220} level="M" bgColor="#ffffff" fgColor="#0b1628" includeMargin aria-label="QR code to link this browser" />
          : error ? (
            <button type="button" className="link-refresh" onClick={() => setRound((value) => value + 1)}><RefreshCw size={22} /><span>{error} Tap to get a new code.</span></button>
          ) : <span className="link-loading">Preparing a code…</span>}
      </div>
      {link && !error && <p className="link-code">Or enter this code on your phone: <strong>{link.code.slice(0, 4)}-{link.code.slice(4)}</strong></p>}
      <p className="link-note"><Lock size={13} /> Your recent chats move to this browser end-to-end encrypted when you scan the QR code.</p>
    </div>
  );
}

function useScanner(videoRef, active, onCode) {
  useEffect(() => {
    if (!active) return undefined;
    let stream = null;
    let frame = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const detector = 'BarcodeDetector' in globalThis ? new globalThis.BarcodeDetector({ formats: ['qr_code'] }) : null;
    async function scan() {
      if (stopped) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2) {
        try {
          let text = null;
          if (detector) text = (await detector.detect(video))[0]?.rawValue ?? null;
          else {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(video, 0, 0);
            text = jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data ?? null;
          }
          if (text && onCode(text)) return;
        } catch { /* keep scanning */ }
      }
      frame = setTimeout(scan, 250);
    }
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((media) => {
        if (stopped) { media.getTracks().forEach((track) => track.stop()); return; }
        stream = media;
        if (videoRef.current) videoRef.current.srcObject = media;
        scan();
      })
      .catch(() => onCode(null));
    return () => {
      stopped = true;
      clearTimeout(frame);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function LinkScanner({ token, onDone, onCancel }) {
  const videoRef = useRef(null);
  const [mode, setMode] = useState('scan');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useScanner(videoRef, mode === 'scan' && !pending, (text) => {
    if (text === null) { setError('Allow the camera to scan, or enter the code instead.'); setMode('code'); return true; }
    const parsed = parseLinkQr(text);
    if (!parsed) return false;
    lookupLink(token, parsed).then((found) => setPending({ ...parsed, deviceName: found.deviceName })).catch((caught) => setError(caught.message));
    return true;
  });

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const state = useChatStore.getState();
      const result = await approveLink(token, pending, () => buildBackupData({
        user: state.user, chats: state.chats, messages: recentSnapshot(state.messages), callLogs: state.callLogs.slice(0, 100), preferences: {}, groups: [],
      }));
      onDone(result.deviceName);
    } catch (caught) {
      setError(caught.message);
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <div className="link-confirm">
        <Laptop size={36} />
        <h3>Link {pending.deviceName}?</h3>
        <p>It will be able to read and send messages as you. Only link a device you are using right now.</p>
        {pending.secret && <p className="link-note"><Lock size={13} /> Your recent chats will be sent to it end-to-end encrypted.</p>}
        {error && <p className="notif-error" role="alert">{error}</p>}
        <div className="link-actions">
          <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="button" className="is-primary" onClick={confirm} disabled={busy}>{busy ? 'Linking…' : 'Link device'}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="link-scanner">
      {mode === 'scan' ? (
        <>
          <div className="link-camera"><video ref={videoRef} autoPlay playsInline muted /><span className="link-frame" aria-hidden="true" /></div>
          <p>Point your phone at the QR code on the other screen.</p>
          <button type="button" className="link-switch" onClick={() => setMode('code')}><Keyboard size={16} /> Enter the code instead</button>
        </>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); lookupLink(token, { code }).then((found) => setPending({ id: found.id, code, deviceName: found.deviceName })).catch((caught) => setError(caught.message)); }}>
          <label className="hm-field">Code shown on the other device<input className="hm-input" value={code} maxLength={9} autoFocus placeholder="ABCD-2345" onChange={(event) => setCode(event.target.value.toUpperCase())} /></label>
          <div className="link-actions">
            <button type="button" onClick={() => setMode('scan')}><Camera size={16} /> Scan instead</button>
            <button type="submit" className="is-primary" disabled={code.replace(/[^A-Z0-9]/g, '').length !== 8}>Continue</button>
          </div>
          <p className="link-note">With a code, chats are not copied to the new device. Scan the QR code to bring them along.</p>
        </form>
      )}
      {error && <p className="notif-error" role="alert">{error}</p>}
      <button type="button" className="link-switch" onClick={onCancel}>Cancel</button>
    </div>
  );
}
