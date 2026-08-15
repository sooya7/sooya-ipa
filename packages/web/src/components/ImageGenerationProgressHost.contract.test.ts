import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('image generation progress host contract', () => {
  it('listens to the real local runtime lifecycle and clears on terminal events', async () => {
    const source = await readFile(new URL('./ImageGenerationProgressHost.tsx', import.meta.url), 'utf8');

    expect(source).toContain("event.type === 'reply.image.generating'");
    expect(source).toContain("event.type === 'reply.media.created' || event.type === 'reply.media.failed'");
    expect(source).toContain("event.type === 'reply.completed' || event.type === 'reply.failed' || event.type === 'reply.interrupted'");
    expect(source).toContain('已等待 {elapsedSeconds} 秒');
    expect(source).toContain('role="progressbar"');
    expect(source).not.toContain('aria-valuenow');
  });

  it('is mounted beside the app so a streaming text draft cannot hide it', async () => {
    const main = await readFile(new URL('../main.tsx', import.meta.url), 'utf8');
    expect(main).toContain('<AppShell />');
    expect(main).toContain('<ImageGenerationProgressHost />');
  });
});
