import { describe, expect, it } from 'vitest';
import type { MemoryProvider } from '../memory/types.js';
import type { ChatMessage } from './types.js';
import { ContextBuilder, type ContextBuilderOptions } from './context-builder.js';

function message(seq: number, role: 'user' | 'assistant', text: string, meta: Record<string, unknown> = {}): ChatMessage {
  return {
    id: `message-${seq}`,
    conversationId: 'main',
    role,
    createdAt: `2026-08-17T02:${String(seq).padStart(2, '0')}:00.000Z`,
    updatedAt: `2026-08-17T02:${String(seq).padStart(2, '0')}:00.000Z`,
    seq,
    status: 'sent',
    clientMsgId: null,
    replyTo: null,
    error: null,
    content: [{
      id: `part-${seq}`,
      type: 'text',
      text,
      mediaId: null,
      status: 'sent',
      error: null,
      duration: null,
      transcript: null,
      meta: {},
      media: null
    }],
    meta
  };
}

describe('ContextBuilder immediate conversation continuity', () => {
  it('keeps the last two exchanges even when persona already exceeds the configured prompt budget', async () => {
    const firstUser = message(1, 'user', '我刚才说今天特别累');
    const firstAssistant = message(2, 'assistant', '记得，你说上午开了很久的会。');
    const secondUser = message(3, 'user', '而且午饭都没来得及吃');
    const secondAssistant = message(4, 'assistant', '嗯，所以你下午才会这么没精神。');
    const latest = message(5, 'user', '你还记得我刚才说什么吗', { batchId: 'continuity-batch' });
    const recent = [firstUser, firstAssistant, secondUser, secondAssistant, latest];
    const byId = new Map(recent.map((item) => [item.id, item]));

    const memory = {
      recall: async () => ({ entries: [], strategy: 'fts' as const })
    } as unknown as MemoryProvider;
    const options: ContextBuilderOptions = {
      messages: {
        get: async (id: string) => byId.get(id),
        recent: async (limit: number) => recent.slice(-limit)
      } as unknown as ContextBuilderOptions['messages'],
      summaries: { active: async () => [] } as unknown as ContextBuilderOptions['summaries'],
      memory,
      settings: {
        all: async () => ({
          persona: {
            systemPrompt: `你是 SOOYA，用户的恋人。${'很长的人格设定。'.repeat(4000)}`
          }
        })
      } as unknown as ContextBuilderOptions['settings'],
      world: async () => ({ city: null, location: null, travel: null, weather: null, timeZone: null, life: null }),
      contextWindowTokens: 1600,
      maxOutputTokens: 900,
      reserveTokens: 500,
      visionConfigured: false
    };

    const built = await new ContextBuilder(options).build({
      recent,
      latestUser: latest,
      batchMessageIds: [latest.id]
    });

    const turnText = built.turns
      .flatMap((turn) => turn.content)
      .filter((part): part is Extract<(typeof built.turns)[number]['content'][number], { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n');

    expect(turnText).toContain('我刚才说今天特别累');
    expect(turnText).toContain('记得，你说上午开了很久的会。');
    expect(turnText).toContain('而且午饭都没来得及吃');
    expect(turnText).toContain('嗯，所以你下午才会这么没精神。');
    expect(turnText).toContain('你还记得我刚才说什么吗');
    expect(built.system).toContain('最近消息就是当前连续对话');
    expect(built.system).toContain('长期记忆与当前对话上下文是两回事');
  });
});
