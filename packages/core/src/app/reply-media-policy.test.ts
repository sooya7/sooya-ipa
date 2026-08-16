import { describe, expect, it } from 'vitest';
import type { ChatMessage } from './types.js';
import { buildImageFallbackPrompt, stripModelMediaExecutionClaims } from './reply-media-policy.js';

function message(id: string, role: ChatMessage['role'], text: string): ChatMessage {
  return {
    id,
    conversationId: 'c1',
    role,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z',
    seq: Number(id.replace(/\D/gu, '')) || 1,
    status: 'sent',
    clientMsgId: null,
    replyTo: null,
    error: null,
    content: [{ id: `${id}-p`, type: 'text', text, mediaId: null, status: 'sent', error: null, duration: null, transcript: null, meta: {} }],
    meta: {}
  };
}

describe('stripModelMediaExecutionClaims', () => {
  it('removes invented image-provider status from explicit media replies', () => {
    const text = '我试一下。接口这次回传的还是空。等通道好了我再发给你。';
    expect(stripModelMediaExecutionClaims(text, true)).toBe('我试一下。等通道好了我再发给你。');
  });

  it('does not rewrite ordinary API discussion when media was not requested', () => {
    const text = '接口这次回传的还是空。';
    expect(stripModelMediaExecutionClaims(text, false)).toBe(text);
  });
});

describe('buildImageFallbackPrompt', () => {
  it('uses an earlier scene and skips prior hallucinated interface chatter', () => {
    const latest = message('m4', 'user', '发张照片');
    const prompt = buildImageFallbackPrompt(
      { wantImage: true, selfieIntent: true },
      [
        message('m1', 'assistant', '我坐在窗边暖黄灯下，手边放着半杯咖啡，穿着浅色毛衣。'),
        message('m2', 'user', '再试试'),
        message('m3', 'assistant', '图片接口没有配置，生图通道回传为空。'),
        latest
      ],
      latest
    );

    expect(prompt).toContain('SOOYA 的自然生活自拍');
    expect(prompt).toContain('窗边暖黄灯');
    expect(prompt).not.toContain('接口没有配置');
  });

  it('always returns a usable prompt for explicit generic image intent', () => {
    const latest = message('m2', 'user', '发张图');
    expect(buildImageFallbackPrompt({ wantImage: true }, [latest], latest)).toBe('一张与当前对话相关的自然生活照片');
  });
});
