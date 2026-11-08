import { apiFetch } from '../api.js';
import { useEffect, useState } from 'react';
import { Check, Copy, Monitor, ShieldCheck, Smartphone, X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { set } from 'idb-keyval';

export default function PairingModal({ onClose, token, userId }) {
  const [pairing, setPairing] = useState(null);
  const [linked, setLinked] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let active = true;
    apiFetch('/api/v1/pairing', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'Could not create a pairing code.');
        if (active) setPairing(body);
      })
      .catch((reason) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [token]);

  async function simulatePairing() {
    if (!pairing) return;
    try {
      const response = await apiFetch(`/api/v1/pairing/${pairing.code}/claim`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Pairing failed.');
      await set(`relay:paired:${userId}`, result);
      setLinked(true);
    } catch (reason) { setError(reason.message); }
  }

  async function copyCode() {
    await navigator.clipboard.writeText(pairing?.code ?? '');
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="pair-modal" role="dialog" aria-modal="true" aria-labelledby="pair-title">
        <button className="modal-close icon-button" onClick={onClose} aria-label="Close pairing dialog"><X size={19} /></button>
        <div className="pair-illustration"><div className="device-back"><Monitor size={30} /></div><div className="device-front"><Smartphone size={25} /></div><span className="pair-spark">+</span></div>
        <span className="eyebrow">LINK A DEVICE</span>
        <h2 id="pair-title">Your conversations,<br />within reach.</h2>
        <p className="pair-description">Use this one-time code on the device you want to link. Keep it private.</p>
        <div className={`qr-frame ${linked ? 'is-linked' : ''}`}>
          {linked ? <div className="linked-state"><span><Check size={30} /></span><strong>Test session created</strong><small>This test ran on the current device.</small></div> : pairing ? <QRCodeSVG value={`relay://pair?code=${pairing.code}`} size={152} level="M" includeMargin /> : <div className="qr-loading" />}
          {!linked && pairing && <button className="copy-code" onClick={copyCode}><Copy size={13} />{copied ? 'Copied' : 'Copy code'}</button>}
        </div>
        {error && <p className="pair-error">{error}</p>}
        {import.meta.env.DEV && <button className="pair-primary" disabled={!pairing || linked} onClick={simulatePairing}>{linked ? 'Paired successfully' : 'Simulate pairing (development only)'}</button>}
        <div className="pair-security"><ShieldCheck size={15} /><span>Short-lived, one-use code · grants account access</span></div>
        <p className="pair-expiry">Code expires in 2 minutes</p>
      </section>
    </div>
  );
}