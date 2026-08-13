// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  localClient: {
    bootstrap: vi.fn(),
    moments: vi.fn(),
    likeMoment: vi.fn()
  },
  api: {
    conversation: vi.fn(),
    moments: vi.fn(),
    likeMoment: vi.fn()
  }
}));

vi.mock('../lib/sooyaClient.js', () => ({ currentSooyaClient: () => mocks.localClient }));
vi.mock('../lib/api.js', () => ({ api: mocks.api }));
vi.mock('../lib/authenticatedMedia.js', () => ({ mediaThumbnailPath: (path: string, width: number) => `${path}?w=${width}` }));
vi.mock('../lib/useAuthenticatedMedia.js', () => ({
  useAuthenticatedMedia: () => ({ url: null, error: null, loading: false, retriable: false, retry: vi.fn() })
}));

import MomentsPage from './MomentsPage.js';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.localClient.bootstrap.mockResolvedValue({
    conversation: undefined,
    messages: { messages: [], hasMore: false, lastEventSeq: 0, lastMessageSeq: 0, oldestSeq: null },
    stickers: [],
    life: { activity: '', kind: 'rest', mood: '', startedAt: '', endsAt: '', recent: [] },
    presence: { city: null, location: null, travel: null, weather: null, updatedAt: '' }
  });
  mocks.localClient.moments.mockResolvedValue({ moments: [], hasMore: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('MomentsPage bootstrap fallback', () => {
  it('renders the default persona when local bootstrap has no conversation', async () => {
    await act(async () => {
      root.render(<MomentsPage />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(mocks.localClient.bootstrap).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('SOOYA');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
