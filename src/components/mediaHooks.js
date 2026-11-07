import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { loadMediaBlob, loadMediaInfo, peekMediaBlob, peekMediaInfo } from '../media.js';

// Content type and size come from the server (HEAD), which owns each file's metadata.
export function useMediaInfo(id, sessionToken) {
  const [state, setState] = useState(() => ({ info: peekMediaInfo(id, sessionToken), error: '' }));
  useEffect(() => {
    if (!id || !sessionToken) return undefined;
    const cached = peekMediaInfo(id, sessionToken);
    if (cached) {
      setState((current) => (current.info === cached ? current : { info: cached, error: '' }));
      return undefined;
    }
    const controller = new AbortController();
    setState({ info: null, error: '' });
    loadMediaInfo(id, sessionToken, controller.signal)
      .then((info) => setState({ info, error: '' }))
      .catch((error) => {
        if (error?.name !== 'AbortError') setState({ info: null, error: error?.message || 'File unavailable.' });
      });
    return () => controller.abort();
  }, [id, sessionToken]);
  return state;
}

// Each consumer owns its object URL, so revoking one never breaks another view of the same bytes.
function useObjectUrl(blob) {
  const [url, setUrl] = useState('');
  useLayoutEffect(() => {
    if (!blob) {
      setUrl('');
      return undefined;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

// Loads the file on demand (or from the shared cache) and reuses the bytes for viewing, playing, and saving.
// Callers key the component by media id; the hook does not reset when the id changes.
export function useMediaBlob(id, sessionToken) {
  const [blob, setBlob] = useState(() => peekMediaBlob(id, sessionToken));
  const [status, setStatus] = useState(blob ? 'ready' : 'idle');
  const [progress, setProgress] = useState(blob ? 1 : 0);
  const [error, setError] = useState('');
  const blobRef = useRef(blob);
  const pendingRef = useRef(null);
  const controllerRef = useRef(null);
  const url = useObjectUrl(blob);

  // Unmount (including StrictMode's simulated one) cancels the transfer and forgets it, so a remount starts afresh.
  useEffect(() => () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    pendingRef.current = null;
  }, []);

  const load = useCallback(() => {
    if (blobRef.current) return Promise.resolve(blobRef.current);
    if (pendingRef.current) return pendingRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    const current = () => controllerRef.current === controller;
    setStatus('loading');
    setProgress(0);
    setError('');
    const pending = loadMediaBlob(id, sessionToken, {
      signal: controller.signal,
      onProgress: (fraction) => {
        if (current()) setProgress(fraction);
      },
    })
      .then((loaded) => {
        if (!current()) throw new DOMException('Superseded', 'AbortError');
        blobRef.current = loaded;
        setBlob(loaded);
        setStatus('ready');
        setProgress(1);
        return loaded;
      })
      .catch((caught) => {
        if (current()) {
          setStatus(caught?.name === 'AbortError' ? 'idle' : 'error');
          if (caught?.name !== 'AbortError') setError(caught?.message || 'Download failed.');
        }
        throw caught;
      })
      .finally(() => {
        if (pendingRef.current === pending) pendingRef.current = null;
      });
    pendingRef.current = pending;
    return pending;
  }, [id, sessionToken]);

  return { status, progress, error, url, blob, load };
}
