// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OTA_MANIFEST_URL, OtaDiagnosticsCard } from './OtaDiagnosticsCard.js';

const adminRequest = vi.hoisted(() => vi.fn());
const checkAndDownload = vi.hoisted(() => vi.fn());
const applyPendingNow = vi.hoisted(() => vi.fn());
const currentOtaUpdater = vi.hoisted(() => vi.fn());
vi.mock('../../lib/admin.js', () => ({ adminRequest }));
vi.mock('../../local/otaUpdater.js', () => ({ currentOtaUpdater }));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  adminRequest.mockReset();
  checkAndDownload.mockReset();
  applyPendingNow.mockReset();
  currentOtaUpdater.mockReset();
  currentOtaUpdater.mockReturnValue({ checkAndDownload, applyPendingNow });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('OtaDiagnosticsCard', () => {
  it('shows the production manifest suggestion when the device has no persisted URL', async () => {
    adminRequest.mockResolvedValueOnce({ manifestUrl: '', state: { pending_web_version: null } });
    await act(async () => {
      root!.render(<OtaDiagnosticsCard onNotice={vi.fn()} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(adminRequest).toHaveBeenCalledWith('/api/admin/ota'));
    expect((container!.querySelector('[data-testid="admin-ota-manifest-url"]') as HTMLInputElement).value).toBe(DEFAULT_OTA_MANIFEST_URL);
    expect(container!.textContent).toContain('当前没有持久化 OTA 地址');
  });

  it('persists the default manifest URL from the diagnostics card', async () => {
    const notice = vi.fn();
    adminRequest
      .mockResolvedValueOnce({ manifestUrl: '', state: {} })
      .mockResolvedValueOnce({ manifestUrl: DEFAULT_OTA_MANIFEST_URL, state: {} });
    await act(async () => {
      root!.render(<OtaDiagnosticsCard onNotice={notice} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(adminRequest).toHaveBeenCalledTimes(1));
    const button = Array.from(container!.querySelectorAll('button')).find((item) => item.textContent === '写入默认地址') as HTMLButtonElement;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(adminRequest).toHaveBeenCalledWith('/api/admin/ota', { method: 'PUT', body: { manifestUrl: DEFAULT_OTA_MANIFEST_URL } }));
    expect(notice).toHaveBeenCalledWith('OTA Manifest 地址已保存');
  });

  it('checks, downloads and applies an OTA from the manual button without a user cold restart', async () => {
    const notice = vi.fn();
    adminRequest.mockResolvedValue({ manifestUrl: DEFAULT_OTA_MANIFEST_URL, state: {} });
    checkAndDownload.mockResolvedValue({ checked: true, downloaded: true, releaseId: 'ota-next' });
    applyPendingNow.mockResolvedValue({ applied: true, releaseId: 'ota-next' });

    await act(async () => {
      root!.render(<OtaDiagnosticsCard onNotice={notice} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(adminRequest).toHaveBeenCalled());
    const button = Array.from(container!.querySelectorAll('button')).find((item) => item.textContent === '检查并立即安装') as HTMLButtonElement;
    await act(async () => {
      button.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await vi.waitFor(() => expect(checkAndDownload).toHaveBeenCalledWith(DEFAULT_OTA_MANIFEST_URL));
    expect(applyPendingNow).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith('OTA 已下载，正在立即切换版本…');
  });
});
