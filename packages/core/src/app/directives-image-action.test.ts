import { describe, expect, it } from 'vitest';
import { stripModelDirectives } from './directives.js';

describe('narrated image action fallback', () => {
  it('turns a claimed real image API action into an actual self-image directive', () => {
    const result = stripModelDirectives(`（这次是真的走了生图接口，不再用文字描述代替画面）\n\n我坐在窗边那盏暖黄灯下，手边是凉了半杯的咖啡，头发是干的，穿着浅色毛衣。\n\n就这一帧，给你看。`);

    expect(result.directives.imagePrompt).toBeUndefined();
    expect(result.directives.selfImagePrompt).toContain('我坐在窗边');
    expect(result.directives.selfImagePrompt).toContain('浅色毛衣');
  });

  it('does not turn an explanation or denial into image generation', () => {
    const result = stripModelDirectives('我没有调用生图接口，只是在解释这个功能为什么没有生效。');

    expect(result.directives.imagePrompt).toBeUndefined();
    expect(result.directives.selfImagePrompt).toBeUndefined();
  });

  it('keeps explicit image markers authoritative', () => {
    const result = stripModelDirectives('这次是真的走了生图接口。[[image:海边的日落]]');

    expect(result.directives.imagePrompt).toBe('海边的日落');
    expect(result.directives.selfImagePrompt).toBeUndefined();
  });
});
