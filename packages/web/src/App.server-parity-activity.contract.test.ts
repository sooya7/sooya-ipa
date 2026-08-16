import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('server parity for reply activity UI', () => {
  it('uses reply activity in the header and the normal typing bubble', async () => {
    const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');

    expect(source).toContain("chat.connection === 'online' ? chat.activity.thinking ? chat.activity.label ?? '正在输入' : '在线'");
    expect(source).toContain("chat.activity.thinking && !streamingMessage");
    expect(source).toContain('data-testid="typing-indicator"');
  });

  it('does not mount a separate floating image-generation progress UI', async () => {
    const main = await readFile(new URL('./main.tsx', import.meta.url), 'utf8');

    expect(main).not.toContain('ImageGenerationProgressHost');
    expect(main).toContain('<AppShell />');
  });
});
