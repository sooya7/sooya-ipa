import { beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../db/migrations.js';
import { NodeLocalDatabase } from '../../test/db/node-local-database.js';
import { MessageRepo, SummaryRepo } from '../db/index.js';
import type { ChatProvider, ChatRequest, ChatResult } from '../providers/types.js';
import { SummaryBuilder } from './summary-builder.js';

function fakeProvider(name: string, options: { configured?: boolean; fail?: boolean; onComplete?: (request: ChatRequest) => void } = {}): ChatProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    name,
    configured: options.configured ?? true,
    calls,
    async complete(request: ChatRequest): Promise<ChatResult> {
      calls.push(request);
      options.onComplete?.(request);
      if (options.fail) throw new Error(`${name} failed`);
      return { text: `${name}-摘要`, model: `${name}-model` };
    },
    async stream(): Promise<ChatResult> { throw new Error('summary builder never streams'); },
    async inspectHealth() { return { capability: 'chat', configured: options.configured ?? true, ok: options.configured ?? true, provider: name, checkedAt: new Date().toISOString() }; }
  };
}

describe('SummaryBuilder provider slot', () => {
  let db: NodeLocalDatabase;
  let messages: MessageRepo;
  let summaries: SummaryRepo;

  beforeEach(async () => {
    db = new NodeLocalDatabase();
    await migrateDatabase(db);
    const now = new Date('2026-08-13T04:00:00.000Z');
    messages = new MessageRepo(db, () => now);
    summaries = new SummaryRepo(db, () => now);
    await messages.create({ role: 'user', parts: [{ type: 'text', text: '今天吃了草莓蛋糕' }] });
    await messages.create({ role: 'assistant', parts: [{ type: 'text', text: '听起来很开心' }] });
    await messages.create({ role: 'user', parts: [{ type: 'text', text: '明天想去看海' }] });
  });

  it('uses the independent summary provider before chat', async () => {
    const summaryProvider = fakeProvider('summary');
    const chatProvider = fakeProvider('chat');
    const builder = new SummaryBuilder({ messages, summaries, summaryProvider, chatProvider });

    const result = await builder.build();

    expect(result.state).toBe('created');
    expect(summaryProvider.calls).toHaveLength(1);
    expect(chatProvider.calls).toHaveLength(0);
    expect(result.summary?.content).toBe('summary-摘要');
    expect(result.summary?.model).toBe('summary-model');
  });

  it('falls back to chat when the summary slot is unconfigured', async () => {
    const summaryProvider = fakeProvider('summary', { configured: false });
    const chatProvider = fakeProvider('chat');
    const builder = new SummaryBuilder({ messages, summaries, summaryProvider, chatProvider });

    const result = await builder.build();

    expect(result.state).toBe('created');
    expect(summaryProvider.calls).toHaveLength(0);
    expect(chatProvider.calls).toHaveLength(1);
    expect(result.summary?.model).toBe('chat-model');
  });

  it('does not fake success when both summary and chat slots are unavailable', async () => {
    const summaryProvider = fakeProvider('summary', { configured: false });
    const chatProvider = fakeProvider('chat', { configured: false });
    const builder = new SummaryBuilder({ messages, summaries, summaryProvider, chatProvider });

    const result = await builder.build();

    expect(result.state).toBe('noop');
    expect(result.summary).toBeUndefined();
    expect(await summaries.count()).toBe(0);
    expect(summaryProvider.calls).toHaveLength(0);
    expect(chatProvider.calls).toHaveLength(0);
  });

  it('propagates a configured summary provider failure instead of fabricating a fallback summary', async () => {
    const summaryProvider = fakeProvider('summary', { fail: true });
    const builder = new SummaryBuilder({ messages, summaries, summaryProvider });

    await expect(builder.build()).rejects.toThrow('summary failed');
    expect(await summaries.count()).toBe(0);
  });
});
