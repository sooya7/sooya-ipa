// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_OTA_MANIFEST_URL, OtaDiagnosticsCard, versionText } from './OtaDiagnosticsCard.js';

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
  it('renders monotonic OTA release IDs as a short sequence number', () => {
    expect(versionText('ota-81')).toBe('OTA #81');
    expect(versionText('ota-00e9bfd2ba045835bca08b15891962581a3d6d68')).toBe('ota-00e9bfd2ba045835bca08b15891962581a3d6d68');
    expect(versionText(null)).toBe('暂无');
  });

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

  it('shows sequence versions in the diagnostics grid', async () => {
    adminRequest.mockResolvedValueOnce({
      manifestUrl: DEFAULT_OTA_MANIFEST_URL,
      state: {
        current_web_version: 'ota-81',
        last_good_web_version: 'ota-80',
        pending_web_version: null
      }
    });
    await act(async () => {
      root!.render(<OtaDiagnosticsCard onNotice={vi.fn()} />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(container!.textContent).toContain('OTA #81'));
    expect(container!.textContent).toContain('OTA #80');
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
    checkAndDownload.mockResolvedValue({ checked: true, downloaded: true, releaseId: 'ota-81' });
    applyPendingNow.mockResolvedValue({ applied: true, releaseId: 'ota-81' });

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
