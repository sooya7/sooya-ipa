import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('chat history navigation owns no scroll restore anchor', () => {
  it('does not save or restore a previous scrollTop when opening or clearing history tools', async () => {
    const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');

    expect(source).not.toContain('historyScrollTopRef');
    expect(source).not.toContain('清除并返回原位置');
    expect(source).toContain('onSearch={() => setHistoryOpen((value) => !value)}');
    expect(source).toContain('className="history-clear" onClick={clearHistoryTools}>清除</button>');
  });
});
