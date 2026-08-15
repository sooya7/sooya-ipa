import { useEffect, useLayoutEffect, useState } from 'react';
import ChatSessionHost from './App.js';
import AdminPanel from './components/AdminPanel.js';
import GalleryPage from './components/GalleryPage.js';
import MomentsPage from './components/MomentsPage.js';
import { ImageViewerHost } from './components/ImageViewerHost.js';
import { useAppRoute } from './lib/navigation.js';
import { isNativeSooya } from './local/nativeRuntime.js';

function snapChatToLatest(): void {
  const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]');
  if (!scroller) return;
  scroller.scrollTop = scroller.scrollHeight;
  scroller.dispatchEvent(new Event('scroll'));
}

export default function AppShell() {
  const route = useAppRoute();
  const [chatStarted, setChatStarted] = useState(route === 'chat');
  const [personaRevision, setPersonaRevision] = useState(0);
  const shouldMountChat = chatStarted || route === 'chat';

  useEffect(() => {
    if (route === 'chat') setChatStarted(true);
  }, [route]);

  // Returning to chat should reopen at the latest message, not revive a stale
  // history anchor from the previous visit. Keep the session host alive, but
  // take over the visible scroller after ChatView's layout restore and release
  // its anchor lock by dispatching the same scroll event a real gesture emits.
  useLayoutEffect(() => {
    if (route !== 'chat') return;
    snapChatToLatest();
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      snapChatToLatest();
      secondFrame = window.requestAnimationFrame(snapChatToLatest);
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [route, personaRevision]);

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
