import { describe, expect, it } from 'vitest';
import { MemoryExtractor, fallbackCandidates } from './extractor.js';
import type { ChatProvider } from '../providers/types.js';

function provider(text: string): ChatProvider {
  return {
    name: 'test-extractor',
    configured: true,
    complete: async () => ({ text, model: 'test' }),
    stream: async () => ({ text, model: 'test' }),
    inspectHealth: async () => ({ capability: 'chat', configured: true, ok: true, provider: 'test', checkedAt: new Date().toISOString() })
  };
}

describe('MemoryExtractor', () => {
  it('uses the model JSON result and clamps untrusted scores', async () => {
    const extractor = new MemoryExtractor({ provider: provider('{"memories":[{"kind":"preference","content":"用户不吃香菜","importance":2,"confidence":-1}]}') });
    await expect(extractor.extract({ batchId: 'b', revision: 1, userText: '我不吃香菜', assistantText: '记住了' })).resolves.toEqual([
      { kind: 'preference', content: '用户不吃香菜', importance: 1, confidence: 0 }
    ]);
  });

  it('falls back to deterministic extraction when the model is unavailable', async () => {
    const extractor = new MemoryExtractor({ provider: null });
    await expect(extractor.extract({ batchId: 'b', revision: 1, userText: '请记住：我周五要复诊', assistantText: '好的' })).resolves.toEqual([
      { kind: 'summary', content: '我周五要复诊', importance: 0.8, confidence: 0.8 }
    ]);
    expect(fallbackCandidates('今天阳光很好')).toEqual([]);
  });
});
