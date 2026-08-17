// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatView, type ChatController } from './App.js';
import type { ChatMessage } from './lib/types.js';

const virtualizerMock = vi.hoisted(() => ({ scrollToIndex: vi.fn() }));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    scrollToIndex: virtualizerMock.scrollToIndex,
    getTotalSize: () => 0,
    getVirtualItems: () => [],
    measureElement: vi.fn()
  })
}));

vi.mock('./lib/useAuthenticatedMedia.js', () => ({
  useAuthenticatedMedia: () => ({ url: null, error: null, loading: false, retriable: false, retry: vi.fn() })
}));
vi.mock('./components/ChatHeader.js', () => ({ ChatHeader: () => null }));
vi.mock('./components/MessageItem.js', () => ({ MessageItem: () => null }));
vi.mock('./components/Composer.js', () => ({ Composer: () => null }));
vi.mock('./components/DateSeparator.js', () => ({ DateSeparator: () => null }));

function makeMessage(id: string, seq: number): ChatMessage {
  return {
    id,
    conversationId: 'main',
    role: 'user',
    createdAt: `2026-08-17T00:00:0${seq}Z`,
    updatedAt: `2026-08-17T00:00:0${seq}Z`,
    seq,
    status: 'sent',
    replyTo: null,
    content: [{ id: `p${seq}`, type: 'text', text: id, status: 'sent' }]
  };
}

function chatController(messages: ChatMessage[]): ChatController {
  return {
    messages,
    persona: null,
    connection: 'online',
    activity: { thinking: false, label: null },
    life: null,
    presence: null,
    stickers: [],
    quotedStates: {},
    replyFailures: {},
    streamingDraft: null,
    hasMore: false,
    loadingOlder: false,
    error: null,
    ready: true,
    send: vi.fn(),
    retryFailed: vi.fn(),
    retryReply: vi.fn(),
    sendAgain: vi.fn(),
    withdraw: vi.fn(),
    loadOlder: vi.fn(),
    ensureQuotedMessage: vi.fn(),
    addMessages: vi.fn(),
    resync: vi.fn(),
    reload: vi.fn(),
    clearError: vi.fn()
  } as unknown as ChatController;
}

let container: HTMLDivElement;
let root: Root;
let scrollerHeight = 0;
let rafCallbacks: FrameRequestCallback[] = [];
let originalScrollHeight: PropertyDescriptor | undefined;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    disconnect() {}
  });
  rafCallbacks = [];
  scrollerHeight = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    rafCallbacks.push(callback);
    return rafCallbacks.length;
  });
  originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get() { return this.classList.contains('scroller') ? scrollerHeight : 0; }
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  virtualizerMock.scrollToIndex.mockClear();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', originalScrollHeight);
  else delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  vi.unstubAllGlobals();
});

describe('ChatView initial scroll', () => {
  it('re-resolves the live bottom instead of replaying a stale message index', async () => {
    scrollerHeight = 900;
    const chat = chatController([makeMessage('m1', 1), makeMessage('m2', 2)]);
    await act(async () => { root.render(<ChatView chat={chat} />); });

    const scroller = container.querySelector<HTMLElement>('[data-testid="scroller"]')!;
    expect(scroller.scrollTop).toBe(900);
    expect(virtualizerMock.scrollToIndex).not.toHaveBeenCalled();

    // Simulate older messages being prepended before the second alignment frame.
    // A captured last index would now point into history; the live bottom remains correct.
    scrollerHeight = 2100;
    const frame = rafCallbacks.shift();
    expect(frame).toBeDefined();
    await act(async () => { frame?.(16); });

    expect(scroller.scrollTop).toBe(2100);
    expect(virtualizerMock.scrollToIndex).not.toHaveBeenCalled();
  });
});
