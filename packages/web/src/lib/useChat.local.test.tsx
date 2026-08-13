// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestLocalClient } from '../local/TestLocalClient.js';
import { useChat } from './useChat.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('useChat local client', () => {
  it('bootstraps, sends, and receives local events without any HTTP request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new TestLocalClient({ now: () => new Date('2026-08-13T03:00:00.000Z') });
    let chat!: ReturnType<typeof useChat>;
    function Probe() { chat = useChat(client); return <div data-ready={String(chat.ready)}>{chat.messages.length}</div>; }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => { root!.render(<Probe />); await Promise.resolve(); });
    expect(chat.ready).toBe(true);
    expect(chat.connection).toBe('online');

    await act(async () => { await chat.send([{ type: 'text', text: '本地消息' }]); });

    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]!.content[0]!.text).toBe('本地消息');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

