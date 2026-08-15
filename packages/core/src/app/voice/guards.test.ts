import { describe, expect, it } from 'vitest';
import { assessNaturalness, estimateSpeechSeconds, splitSentences, voiceTextSimilarity } from './naturalness.js';
import { semanticRiskReport } from './semantic.js';
import { normalizeVoiceText, ruleBasedColloquial } from './normalize.js';
import { DEFAULT_VOICE_EMOTIONS, detectSpeechEmotion, resolveVoiceDelivery } from './emotion.js';

const reply = '我知道啦。今天如果累就早点休息，别硬撑。';

describe('naturalness guard', () => {
  it('rejects a complement that mostly repeats the reply', () => {
    const report = assessNaturalness(reply, reply, 'complement');
    expect(report.accepted).toBe(false);
    expect(report.reasons.some((reason) => reason.startsWith('similarity:'))).toBe(true);
  });

  it('accepts a genuinely different short complement', () => {
    const report = assessNaturalness('乖一点，今晚真的早点睡，好不好。', reply, 'complement', { maxVoiceSeconds: 35 });
    expect(report.accepted).toBe(true);
  });

  it('flags formal phrasing, markdown residue and overlong sentences', () => {
    const script = `综上所述，${'这'.repeat(60)}需要注意。另外还有 **加粗** 残留。`;
    const report = assessNaturalness(script, '别的正文', 'summary');
    expect(report.reasons).toContain('formal:1');
    expect(report.reasons.some((reason) => reason.startsWith('markdown:'))).toBe(true);
    expect(report.reasons.some((reason) => reason.startsWith('max_sentence:'))).toBe(true);
  });

  it('exempts read_aloud from the similarity cap', () => {
    const report = assessNaturalness(reply, reply, 'read_aloud');
    expect(report.accepted).toBe(true);
  });

  it('estimates seconds from CJK and latin content', () => {
    expect(estimateSpeechSeconds('晚安')).toBe(1);
    expect(estimateSpeechSeconds('好'.repeat(42))).toBe(10);
  });

  it('splits sentences on CJK and latin punctuation', () => {
    expect(splitSentences('好。真的吗？Yes!')).toEqual(['好', '真的吗', 'Yes']);
  });

  it('measures literal overlap monotonically', () => {
    expect(voiceTextSimilarity(reply, reply)).toBeGreaterThan(voiceTextSimilarity('晚安，早点睡', reply));
  });
});

describe('semantic guard', () => {
  const canonical = '明天下午三点我们在老地方见。';

  it('passes when high-risk tokens appear in the canonical text', () => {
    expect(semanticRiskReport('明天三点老地方见。', canonical).ok).toBe(true);
  });

  it('rejects invented numbers, amounts and promises', () => {
    expect(semanticRiskReport('明天三点，我保证带 500 块钱过去。', canonical).ok).toBe(false);
    const report = semanticRiskReport('我保证一定到。', canonical);
    expect(report.risks.some((risk) => risk.startsWith('promise:'))).toBe(true);
  });

  it('covers the five high-risk classes', () => {
    expect(semanticRiskReport('要到 100 元。', canonical).risks.some((r) => r.startsWith('amount:'))).toBe(true);
    expect(semanticRiskReport('绝对不可能失败。', canonical).risks.some((r) => r.startsWith('negation:'))).toBe(true);
    expect(semanticRiskReport('周二见。', canonical).risks.some((r) => r.startsWith('date_time:'))).toBe(true);
    expect(semanticRiskReport('有 7 个问题。', canonical).risks.some((r) => r.startsWith('number:'))).toBe(true);
  });
});

describe('normalizeVoiceText', () => {
  it('replaces URLs with a spoken placeholder and keeps the transcript clean', () => {
    const { spokenText, synthesisText } = normalizeVoiceText('看这个 https://example.com/a?b=1 很有趣');
    expect(synthesisText).toContain('链接我放在文字里了');
    expect(synthesisText).not.toContain('https://');
    expect(spokenText).toContain('https://');
  });

  it('strips protocol markers, markdown and lists from the synthesis text', () => {
    const { spokenText, synthesisText } = normalizeVoiceText('[[voice]] 好的 **重点** - 列表项\n# 标题');
    expect(synthesisText).not.toContain('[[');
    expect(synthesisText).not.toContain('**');
    expect(synthesisText).not.toContain('#');
    expect(spokenText).not.toContain('[[');
  });

  it('drops long bracket inserts but keeps short asides', () => {
    const longAside = '（' + '细节'.repeat(25) + '）';
    const out = normalizeVoiceText(`好的${longAside}，早点休息`);
    expect(out.synthesisText).toContain('这个细节文字里写了');
    const short = normalizeVoiceText('好的（轻声），早点休息');
    expect(short.synthesisText).toContain('（轻声）');
  });

  it('splits overlong sentences at commas for readability', () => {
    const long = '今天' + '真的很累'.repeat(12) + '，所以想早点休息。';
    const { synthesisText } = normalizeVoiceText(long);
    expect(synthesisText).toContain('\n');
  });
});

describe('ruleBasedColloquial', () => {
  it('produces a bounded spoken fallback with structure stripped', () => {
    const out = ruleBasedColloquial(`**结论**：先休息。${'细节。'.repeat(80)}`, 60);
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out).not.toContain('**');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('emotion detection and delivery mapping', () => {
  it('classifies reply text through the rule table', () => {
    expect(detectSpeechEmotion('晚安，做个好梦')).toBe('sleepy');
    expect(detectSpeechEmotion('哈哈太好了')).toBe('happy');
    expect(detectSpeechEmotion('普通的一句话')).toBe('neutral');
  });

  it('prefers the requested emotion when the preset exists', () => {
    const delivery = resolveVoiceDelivery('普通正文', 'gentle', DEFAULT_VOICE_EMOTIONS);
    expect(delivery.emotion).toBe('gentle');
    expect(delivery.speed).toBe(0.94);
  });

  it('falls back through detection → neutral for unknown requests', () => {
    // Without a request, detection decides; an unknown requested mood forces
    // neutral (server parity: a bad request never picks a wrong preset).
    expect(resolveVoiceDelivery('哈哈', null, DEFAULT_VOICE_EMOTIONS).emotion).toBe('happy');
    expect(resolveVoiceDelivery('哈哈', 'unknown-mood', DEFAULT_VOICE_EMOTIONS).emotion).toBe('neutral');
    expect(resolveVoiceDelivery('普通', 'unknown-mood', DEFAULT_VOICE_EMOTIONS).emotion).toBe('neutral');
  });
});
