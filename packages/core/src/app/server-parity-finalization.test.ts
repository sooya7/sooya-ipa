import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('server parity finalization manifest', () => {
  it('locks the archive gate and every B–E domain in the parity manifest', async () => {
    const manifest = await readFile(new URL('../../../../docs/SERVER_PARITY.md', import.meta.url), 'utf8');

    for (const marker of [
      'Context (budget/multimodal/batch/summary slot)',
      'Life V2 + Location Runtime',
      'Moments + Sticker Intelligence',
      'Durable runtime + Local notifications',
      'Archive Gate',
      'iOS unsigned workflow',
      '实机 smoke',
      '观察期无 blocking regression'
    ]) {
      expect(manifest).toContain(marker);
    }
    expect(manifest).toContain('服务器仓库在最后三项人工确认前保持 read-only/historical reference');
  });

  it('keeps the final E2E matrix complete', async () => {
    const matrix = await readFile(new URL('../../../../docs/E2E_PARITY_MATRIX.md', import.meta.url), 'utf8');

    for (const flow of [
      'Chat', 'Vision', 'Sticker', 'Image', 'Voice', 'Web Search', 'MCP', 'Memory',
      'Summary', 'Life catch-up', 'Location travel', 'Moment', 'Sticker picker',
      'Notification', 'Backup', 'migration', 'OTA'
    ]) {
      expect(matrix).toContain(flow);
    }
  });
});
