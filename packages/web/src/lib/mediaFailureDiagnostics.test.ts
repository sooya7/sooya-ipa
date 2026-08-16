import { describe, expect, it } from 'vitest';
import { formatMediaFailureMessage } from './useChat.js';

describe('formatMediaFailureMessage', () => {
  it('保留图片失败的阶段、Provider、耗时和 HTTP 状态', () => {
    expect(formatMediaFailureMessage({
      type: 'image',
      stage: 'download',
      provider: 'anuma-input-images',
      elapsedMs: 12_345,
      status: 502,
      referenceCount: 1,
      error: 'The network connection was lost.'
    })).toBe('The network connection was lost.\n阶段：download（成品下载） · Provider：anuma-input-images · 耗时：12.3s · HTTP：502 · 参考图：1');
  });

  it('生成阶段超时时能直接看出故障发生在上游请求', () => {
    expect(formatMediaFailureMessage({
      type: 'image',
      stage: 'generation',
      provider: 'openai-compatible',
      elapsedMs: 20_000,
      error: 'Request timed out'
    })).toBe('Request timed out\n阶段：generation（生成请求） · Provider：openai-compatible · 耗时：20.0s');
  });

  it('非图片媒体保持原来的简洁错误文案', () => {
    expect(formatMediaFailureMessage({ type: 'audio', error: 'TTS unavailable' })).toBe('TTS unavailable');
    expect(formatMediaFailureMessage({ type: 'sticker' })).toBe('多媒体生成失败。');
  });
});
