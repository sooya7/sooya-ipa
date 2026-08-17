import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('server parity for reply activity UI', () => {
  it('keeps reply activity in the header but lets a persisted pending image replace the duplicate typing bubble', async () => {
    const source = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');

    expect(source).toContain("chat.connection === 'online' ? chat.activity.thinking ? chat.activity.label ?? '正在输入' : '在线'");
    expect(source).toContain("const hasPendingAssistantImage = useMemo");
    expect(source).toContain("part.type === 'image' && part.status === 'pending' && !part.media");
    expect(source).toContain('const showTypingIndicator = chat.activity.thinking');
    expect(source).toContain('&& !hasPendingAssistantImage;');
    expect(source).not.toContain("chat.activity.label === '正在生成图片' && hasPendingAssistantImage");
    expect(source).toContain('data-testid="typing-indicator"');
  });

  it('does not mount a separate floating image-generation progress UI', async () => {
    const main = await readFile(new URL('./main.tsx', import.meta.url), 'utf8');

    expect(main).not.toContain('ImageGenerationProgressHost');
    expect(main).toContain('<AppShell />');
  });
});
