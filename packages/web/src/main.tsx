import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AppShell from './AppShell.js';
import './styles.css';
import './components/AdminPanel.css';
import './components/life/LifeObservationPanel.css';
import './components/ScrollableLists.css';
import './components/overlays.css';
import './components/FeatureEnhancements.css';
import { shouldRegisterPwaServiceWorker, isNativeSooya } from './local/nativeRuntime.js';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');

// Native (iPhone) installs LocalCore before the first render so the shell
// boots against local data; browser/PWA keeps the remote API adapter.
if (isNativeSooya()) {
  void import('./local/nativeBoot.js')
    .then(({ installNativeLocalCore }) => installNativeLocalCore())
    .catch((error) => console.error('LocalCore bootstrap failed, falling back to remote API', error));
}

createRoot(container).render(
  <StrictMode>
    <AppShell />
  </StrictMode>
);

if (shouldRegisterPwaServiceWorker(import.meta.env.PROD, 'serviceWorker' in navigator)) {
  window.addEventListener('load', () => {
    void import('./lib/serviceWorkerUpdate.js')
      .then(({ registerServiceWorkerUpdate }) =>
        registerServiceWorkerUpdate((controller) => {
          // App.tsx renders the prompt; the worker keeps waiting until the user answers.
          window.dispatchEvent(new CustomEvent('sooya:sw-update-ready', { detail: controller }));
        })
      )
      .catch(() => { /* PWA is optional */ });
  });
}
