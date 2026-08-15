import { describe, expect, it } from 'vitest';
import { parseUserDirectives } from './directives.js';

describe('generic image requests', () => {
  it('treats 发张图 as an executable assistant-photo request', () => {
    expect(parseUserDirectives('发张图')).toMatchObject({
      wantImage: true,
      selfieIntent: true,
      imagePrompt: '自然生活自拍'
    });
  });

  it('keeps explicit scene prompts authoritative', () => {
    expect(parseUserDirectives('发张图 海边的晚霞')).toMatchObject({
      wantImage: true,
      imagePrompt: '海边的晚霞'
    });
  });
});
