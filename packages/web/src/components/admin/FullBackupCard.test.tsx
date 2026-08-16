// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FullBackupCard } from './FullBackupCard.js';

const fullBackupAvailable = vi.hoisted(() => vi.fn(() => true));
const pickFullBackup = vi.hoisted(() => vi.fn());
const importFullBackup = vi.hoisted(() => vi.fn());
const exportFullBackup = vi.hoisted(() => vi.fn());

vi.mock('../../local/fullBackup.js', () => ({
  fullBackupAvailable,
  pickFullBackup,
  importFullBackup,
  exportFullBackup
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  fullBackupAvailable.mockReturnValue(true);
  pickFullBackup.mockReset();
  importFullBackup.mockReset();
  exportFullBackup.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('FullBackupCard server migration', () => {
  it('recognizes a server migration package and does not ask for a backup password', async () => {
    pickFullBackup.mockResolvedValue({
      archiveName: 'imports/incoming.zip',
      displayName: 'SOOYA-server-to-IPA-20260815T030000Z-abcd1234.zip',
      bytes: 4096
    });

    await act(async () => root!.render(<FullBackupCard onNotice={vi.fn()} />));
    const choose = Array.from(container!.querySelectorAll('button')).find((item) => item.textContent === '选择备份文件') as HTMLButtonElement;
    await act(async () => {
      choose.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container!.textContent).toContain('服务器 → IPA 迁移包');
    expect(container!.textContent).toContain('不迁服务器记忆和表情包');
    expect(container!.textContent).toContain('迁入服务器数据');
    expect(container!.querySelector('input[placeholder="未包含密钥可留空"]')).toBeNull();
  });

  it('distinguishes the full archive from ordinary database rollback points', async () => {
    await act(async () => root!.render(<FullBackupCard onNotice={vi.fn()} />));
    expect(container!.textContent).toContain('导出 IPA 完整备份');
    expect(container!.textContent).toContain('它不是数据库回滚点');
    expect(container!.textContent).toContain('运维与备份');
  });
});
