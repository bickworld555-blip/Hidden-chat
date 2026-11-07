import { useEffect, useRef, useState } from 'react';
import { Camera, Image as ImageIcon, Pencil, Trash2, X } from 'lucide-react';
import Avatar from './Avatar.jsx';
import { useChatStore } from '../store.js';
import { prepareAvatarBlob, removeAvatar, uploadAvatar } from '../avatar.js';

// The signed-in user's photo with a pencil button; tapping it offers camera, gallery or remove.
export default function ProfilePhoto({ size = 'large', className = '' }) {
  const user = useChatStore((state) => state.user);
  const sessionToken = useChatStore((state) => state.sessionToken);
  const updateUserProfile = useChatStore((state) => state.updateUserProfile);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const cameraRef = useRef(null);
  const galleryRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function apply(work) {
    setBusy(true);
    setError('');
    try {
      const updated = await work();
      updateUserProfile(updated);
      setOpen(false);
    } catch (caught) {
      setError(caught?.message || 'Could not update your photo.');
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(event) {
    const [file] = event.target.files ?? [];
    event.target.value = '';
    if (!file) return;
    await apply(async () => uploadAvatar(await prepareAvatarBlob(file), sessionToken));
  }

  const canEdit = Boolean(user && sessionToken);

  return (
    <span className={`profile-photo ${className}`}>
      <Avatar {...(user ?? { name: 'You', initials: '?' })} size={size} />
      {canEdit && (
        <button type="button" className="profile-photo-edit" onClick={() => setOpen(true)} aria-label="Edit profile photo" title="Edit profile photo">
          <Pencil size={14} />
        </button>
      )}
      <input ref={cameraRef} type="file" accept="image/*" capture="user" hidden onChange={handleFile} />
      <input ref={galleryRef} type="file" accept="image/*" hidden onChange={handleFile} />
      {open && (
        <div className="profile-photo-backdrop" onClick={() => !busy && setOpen(false)} role="presentation">
          <div className="profile-photo-sheet" role="dialog" aria-modal="true" aria-label="Profile photo" onClick={(event) => event.stopPropagation()}>
            <header>
              <strong>Profile photo</strong>
              <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close" disabled={busy}><X size={18} /></button>
            </header>
            <div className="profile-photo-preview"><Avatar {...(user ?? { name: 'You', initials: '?' })} size="xl" /></div>
            <div className="profile-photo-options">
              <button type="button" onClick={() => cameraRef.current?.click()} disabled={busy}><Camera size={22} /><span>Take photo</span></button>
              <button type="button" onClick={() => galleryRef.current?.click()} disabled={busy}><ImageIcon size={22} /><span>Choose from gallery</span></button>
              {user?.avatar && (
                <button type="button" className="danger" onClick={() => apply(() => removeAvatar(sessionToken))} disabled={busy}><Trash2 size={22} /><span>Remove photo</span></button>
              )}
            </div>
            {busy && <p className="profile-photo-status" role="status">Updating…</p>}
            {error && <p className="profile-photo-status is-error" role="alert">{error}</p>}
          </div>
        </div>
      )}
    </span>
  );
}
