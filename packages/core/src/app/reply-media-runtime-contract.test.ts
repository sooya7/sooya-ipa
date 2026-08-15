import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('reply media runtime contract', () => {
  it('keeps explicit image intent mandatory without making image failures fatal', async () => {
    const source = await readFile(new URL('./reply-coordinator.ts', import.meta.url), 'utf8');

    expect(source).toContain('requiredImage: user.wantImage || undefined');
    expect(source).toContain("throw new Error('provider returned an empty reply')");
    expect(source).toContain('buildImageFallbackPrompt(userDirectives, recent, latestUser)');
    // The old behavior (image error -> throw -> whole reply failed) must stay gone.
    expect(source).not.toContain('if (directives.requiredImage) throw error;');
    expect(source).toContain('IMAGE_FAILURE_FALLBACK_TEXT');
    expect(source).toContain("this.failImage(result, messageId, context, { stage: stageOf(error, 'generation')");
  });

  it('emits image generation lifecycle before the real provider call', async () => {
    const source = await readFile(new URL('./reply-coordinator.ts', import.meta.url), 'utf8');
    const started = source.indexOf("this.options.emit('reply.image.generating'");
    const generated = source.indexOf('await provider.generate(imagePrompt');

    expect(started).toBeGreaterThan(-1);
    expect(generated).toBeGreaterThan(started);
    expect(source).toContain("this.options.emit('reply.media.created', { batchId, revision, messageId, type: 'image'");
    expect(source).toContain("this.options.emit('reply.media.failed'");
    expect(source).toContain("const stage = pipeline?.stage ?? input.stage;");
  });

  it('retires the active generation before completed events and memory post-processing', async () => {
    const source = await readFile(new URL('./reply-coordinator.ts', import.meta.url), 'utf8');
    const completedBatch = source.indexOf('this.options.batches.complete(batchId, assistant.id, revision)');
    const retired = source.indexOf('this.active.delete(batchId)', completedBatch);
    const completedEvent = source.indexOf("this.options.emit('reply.completed'", completedBatch);
    const memoryCommit = source.indexOf('void this.commitMemory(', completedBatch);

    expect(completedBatch).toBeGreaterThan(-1);
    expect(retired).toBeGreaterThan(completedBatch);
    expect(completedEvent).toBeGreaterThan(retired);
    expect(memoryCommit).toBeGreaterThan(completedEvent);
  });

  it('tells the model that only Runtime owns media execution status', async () => {
    const source = await readFile(new URL('./reply-coordinator.ts', import.meta.url), 'utf8');

    expect(source).toContain('你看不到它的配置状态、调用结果或错误');
    expect(source).toContain('不要声称接口已调用、未配置、失败、成功、回传为空或通道不可用');
  });
});
