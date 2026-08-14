import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AppShell from './AppShell.js';
import './styles.css';
import './native.css';
import './components/AdminPanel.css';
import './components/life/LifeObservationPanel.css';
import './components/ScrollableLists.css';
import './components/overlays.css';
import './components/FeatureEnhancements.css';
import { shouldRegisterPwaServiceWorker, isNativeSooya } from './local/nativeRuntime.js';

const container = document.getElementById('root');
if (!container) throw new Error('root container missing');
const root = createRoot(container);
const native = isNativeSooya();
if (native) document.documentElement.classList.add('sooya-native');

// Native (iPhone) must install the in-process LocalCore before React mounts.
// Rendering the remote adapter after a native bootstrap failure creates a
// half-alive app: chat reports a fake network outage, local avatars disappear,
// and Moments/Admin fall through to HTTP routes that do not exist in the IPA.
const renderApp = () => root.render(
  <StrictMode>
    <AppShell />
  </StrictMode>
);

const renderNativeStartupError = (error: unknown) => {
  const detail = error instanceof Error && error.message ? error.message : '未知启动错误';
  root.render(
    <StrictMode>
      <main className="gate" role="alert">
        <div className="gate-card">
          <h1>SOOYA</h1>
          <p>本地核心启动失败</p>
          <small>{detail}</small>
          <button type="button" onClick={() => window.location.reload()}>重新启动</button>
        </div>
      </main>
    </StrictMode>
  );
};

if (native) {
  // Capacitor 8 requires local custom plugins to be registered in JS before
  // the bridge proxies are consumed by nativeBoot.ts.
  void import('./local/nativePluginRegistry.js')
    .then(() => import('./local/nativeBoot.js'))
    .then(({ installNativeLocalCore }) => installNativeLocalCore())
    .then((installed) => {
      if (!installed) throw new Error('Native LocalCore 未安装');
      renderApp();
    })
    .catch((error) => {
      console.error('LocalCore bootstrap failed', error);
      renderNativeStartupError(error);
    });
} else {
  renderApp();
}

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
