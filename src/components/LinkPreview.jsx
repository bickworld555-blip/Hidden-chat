import { useEffect, useState } from 'react';
import { Clapperboard, Link2 } from 'lucide-react';
import { apiFetch } from '../api.js';
import { nativeOpenExternal, nativeShell } from '../native.js';

// One request per link for the whole session (every bubble showing the same link shares it).
const previews = new Map();

export function loadLinkPreview(href, sessionToken) {
  if (!previews.has(href)) {
    previews.set(href, apiFetch(`/api/v1/link-preview?url=${encodeURIComponent(href)}`, { headers: { Authorization: `Bearer ${sessionToken}` } })
      .then((response) => (response.status === 200 ? response.json() : null))
      .catch(() => { previews.delete(href); return null; }));
  }
  return previews.get(href);
}

export function linkHost(href) {
  try { return new URL(href).hostname.replace(/^www\.|^m\.|^web\./, ''); } catch { return ''; }
}

export function previewDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function ProviderIcon({ provider }) {
  if (provider === 'facebook') return <span className="link-provider is-facebook" aria-label="Facebook">f</span>;
  if (provider === 'youtube') return <span className="link-provider is-youtube" aria-label="YouTube">▶</span>;
  if (provider === 'instagram') return <span className="link-provider is-instagram" aria-label="Instagram">◎</span>;
  if (provider === 'tiktok') return <span className="link-provider is-tiktok" aria-label="TikTok">♪</span>;
  return null;
}

// WhatsApp's card for a shared link: thumbnail (with a video badge for reels and videos), title, description and
// the site with its logo. Tapping opens the link in its app (YouTube, Facebook) or the browser.
// `preview` is the card the sender made (it came inside the encrypted message, thumbnail included): nothing is
// fetched. Without one, only messages that were not end-to-end encrypted (`fetchAllowed`) ask the server.
export default function LinkPreview({ href, sessionToken, preview: given = null, fetchAllowed = true }) {
  const [fetched, setFetched] = useState(null);
  const [imageFailed, setImageFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (given || !fetchAllowed || !href || !sessionToken) return undefined;
    loadLinkPreview(href, sessionToken).then((value) => { if (alive) setFetched(value); });
    return () => { alive = false; };
  }, [href, sessionToken, given, fetchAllowed]);
  const preview = given ? { ...given, image: given.thumbnail || '' } : fetched;

  if (!preview) return null;
  const open = (event) => {
    event.stopPropagation();
    if (!nativeShell()) return;
    event.preventDefault();
    nativeOpenExternal(href);
  };
  const showImage = preview.image && !imageFailed;
  return (
    <a className={`link-preview ${preview.video ? 'is-video' : ''}`} href={href} target="_blank" rel="noopener noreferrer" onClick={open}>
      {showImage && (
        <span className="link-preview-image">
          <img src={preview.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
          {preview.video && (
            <span className="link-preview-badge"><Clapperboard size={14} aria-hidden="true" />{previewDuration(preview.duration)}</span>
          )}
        </span>
      )}
      <span className="link-preview-text">
        {preview.title && <strong>{preview.title}</strong>}
        {preview.description && preview.description !== preview.title && <small>{preview.description}</small>}
        <span className="link-preview-site">
          <Link2 size={14} aria-hidden="true" />
          <span>{linkHost(href)}</span>
          <ProviderIcon provider={preview.provider} />
        </span>
      </span>
    </a>
  );
}
