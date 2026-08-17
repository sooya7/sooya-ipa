import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('admin chat model probe', () => {
  it('gives reasoning models room to produce visible text and reports empty output accurately', async () => {
    const source = await readFile(new URL('./local-core.ts', import.meta.url), 'utf8');

    expect(source).toContain('const probeMaxTokens = 1024;');
    expect(source).toContain("text: '只回复 OK，不要解释。'");
    expect(source).toContain('maxTokens: probeMaxTokens');
    expect(source).toContain("result.finishReason === 'length'");
    expect(source).toContain('finish_reason: ${result.finishReason}');
    expect(source).not.toContain('maxTokens: 16');
    expect(source).not.toContain('可能被最大输出 token 截断');
  });
});
