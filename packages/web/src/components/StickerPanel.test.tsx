// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SooyaClient } from '../lib/sooyaClient.js';
import { clearSooyaClient, installSooyaClient } from '../lib/sooyaClient.js';
import { StickerPanel } from './StickerPanel.js';

vi.mock('./AuthenticatedMedia.js', () => ({
  AuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} />
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => clearSooyaClient());

describe('StickerPanel', () => {
  it('bootstrap 为空时仍从本地表情库刷新第一页', async () => {
    const stickerSearch = vi.fn(async () => ({
      stickers: [{ id: 's1', mediaId: 'm1', name: '服务器表情', emotion: 'happy', tags: [], url: 'media://m1' }],
      total: 244,
      nextCursor: '60'
    }));
    installSooyaClient({ stickerSearch } as unknown as SooyaClient);
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<StickerPanel stickers={[]} onSelect={vi.fn()} />);
      await Promise.resolve();
    });

    expect(stickerSearch).toHaveBeenCalledWith({ scope: 'all', q: '', limit: 60 });
    expect(container.textContent).toContain('服务器表情');
    expect(container.textContent).toContain('加载更多');

    await act(async () => root.unmount());
    container.remove();
  });
});
