import { useEffect, useState } from 'react';
import ChatSessionHost from './App.js';
import AdminPanel from './components/AdminPanel.js';
import GalleryPage from './components/GalleryPage.js';
import MomentsPage from './components/MomentsPage.js';
import { ImageViewerHost } from './components/ImageViewerHost.js';
import { useAppRoute } from './lib/navigation.js';
import { isNativeSooya } from './local/nativeRuntime.js';

export default function AppShell() {
  const route = useAppRoute();
  const [chatStarted, setChatStarted] = useState(route === 'chat');
  const [personaRevision, setPersonaRevision] = useState(0);
  const shouldMountChat = chatStarted || route === 'chat';

  useEffect(() => {
    if (route === 'chat') setChatStarted(true);
  }, [route]);

  useEffect(() => {
    const refreshPersona = () => setPersonaRevision((value) => value + 1);
    window.addEventListener('sooya:persona-updated', refreshPersona);
    return () => window.removeEventListener('sooya:persona-updated', refreshPersona);
  }, []);

  // notifyAppReady is deliberately deferred until the shell has mounted. A
  // successful SQLite/provider bootstrap alone must not bless a broken OTA
  // bundle as the last-good version.
  useEffect(() => {
    if (!isNativeSooya()) return;
    void import('./local/nativeBoot.js').then(({ notifyNativeAppReady }) => notifyNativeAppReady()).catch(() => undefined);
  }, []);

  return <>
    {shouldMountChat && <ChatSessionHost key={personaRevision} active={route === 'chat'} />}
    {(route === 'chat' || route === 'moments') && <ImageViewerHost />}
    {route === 'moments' && <MomentsPage />}
    {route === 'gallery' && <GalleryPage />}
    {route === 'admin' && <AdminPanel />}
  </>;
}
