import { describe, expect, it } from 'vitest';
import { mergeVoiceDirectives, parseVoiceIntent } from './intent.js';

describe('parseVoiceIntent', () => {
  it('separates reply / only / read-aloud / off (server parity §22.3)', () => {
    expect(parseVoiceIntent('用语音回我')).toBe('voice_reply');
    expect(parseVoiceIntent('只发语音，别打字')).toBe('voice_only');
    expect(parseVoiceIntent('把这段念出来')).toBe('read_aloud');
    expect(parseVoiceIntent('你会发语音吗？')).toBe('none');
    expect(parseVoiceIntent('算了，别发语音')).toBe('no_voice');
    expect(parseVoiceIntent('今天好累')).toBe('none');
  });

  it('resolves mixed phrasing through the hard precedence order', () => {
    // Matches both NO_VOICE (不要发语音) and VOICE_REPLY (发语音消息): no_voice wins.
    expect(parseVoiceIntent('不要发语音消息')).toBe('no_voice');
    expect(parseVoiceIntent('只发语音就行')).toBe('voice_only');
    expect(parseVoiceIntent('read it aloud')).toBe('read_aloud');
    expect(parseVoiceIntent('voice message please')).toBe('voice_reply');
  });
});

describe('mergeVoiceDirectives (batch semantics)', () => {
  it('lets the last explicit directive win across a batch', () => {
    const merged = mergeVoiceDirectives([{ text: '用语音回我' }, { text: '算了打字就好' }]);
    expect(merged.intent).toBe('no_voice');
  });

  it('keeps an earlier explicit voice request alive over a plain follow-up', () => {
    const merged = mergeVoiceDirectives([{ text: '用语音回我' }, { text: '你今天在干嘛' }]);
    expect(merged.intent).toBe('voice_reply');
  });

  it('ignores empty messages', () => {
    expect(mergeVoiceDirectives([undefined, { text: '' }, { text: '随便聊聊' }]).intent).toBe('none');
  });
});
