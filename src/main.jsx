import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AppErrorBoundary from './components/AppErrorBoundary.jsx';
import './styles.css';
import { registerServiceWorker } from './pwa.js';
import { watchKeyboard } from './keyboard.js';
import { SIGNED_IN_HINT, entryFor } from './site/links.js';

// The public website (/, /features, /privacy, /business, /download, /help) or the messenger (/app and every other
// path, and always in the Android app). Signed-in visitors to the home page go straight to the messenger.
const PublicSite = lazy(() => import('./site/PublicSite.jsx'));
const native = Boolean(globalThis.Capacitor?.isNativePlatform?.());
let signedIn = false;
try { signedIn = localStorage.getItem(SIGNED_IN_HINT) === '1'; } catch { /* treat as signed out */ }
const entry = entryFor(location.pathname, { native, signedIn });

if (entry === 'redirect-app') {
  location.replace(`/app${location.search}`);
} else {
  if (entry === 'app') watchKeyboard();
  createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <AppErrorBoundary>
        {entry === 'site' ? <Suspense fallback={null}><PublicSite /></Suspense> : <App />}
      </AppErrorBoundary>
    </React.StrictMode>,
  );
  registerServiceWorker();
}
