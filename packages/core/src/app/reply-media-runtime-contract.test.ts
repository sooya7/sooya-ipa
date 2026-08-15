import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('reply media runtime contract', () => {
  it('makes explicit image intent mandatory and propagates real image failures', async () => {
    const source = await readFile(new URL('./reply-coordinator.ts', import.meta.url), 'utf8');

    expect(source).toContain('requiredImage: user.wantImage || undefined');
    expect(source).toContain("throw new Error('image provider is not configured')");
    expect(source).toContain('if (directives.requiredImage) throw error;');
    expect(source).toContain('buildImageFallbackPrompt(userDirectives, recent, latestUser)');
  });

  it('tells the model that only Runtime owns media execution status', async () => {
    const source = await readFile(new URL('./reply-coordinator.ts', import.meta.url), 'utf8');

    expect(source).toContain('你看不到它的配置状态、调用结果或错误');
    expect(source).toContain('不要声称接口已调用、未配置、失败、成功、回传为空或通道不可用');
  });
});
