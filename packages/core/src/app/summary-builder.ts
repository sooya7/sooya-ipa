import type { MessageRepo } from '../db/message.repo.js';
import type { SummaryRepo, SummaryRow } from '../db/misc.repo.js';
import type { ChatProvider } from '../providers/types.js';
import type { ChatMessage } from './types.js';
import { messageText } from './context/multimodal.js';

type ProviderResolver = ChatProvider | null | undefined | (() => Promise<ChatProvider | null>);

export interface SummaryBuilderOptions {
  messages: MessageRepo;
  summaries: SummaryRepo;
  /** Independent summary provider slot; the production wiring is `summary ?? chat`. */
  summaryProvider?: ProviderResolver;
  /** Compatibility chat slot. Used only when no independent summary is configured. */
  chatProvider?: ProviderResolver;
  /** @deprecated Compatibility alias for `chatProvider`. */
  provider?: ProviderResolver;
  maxMessages?: number;
}

export interface SummaryBuildResult {
  state: 'created' | 'noop';
  summary?: SummaryRow;
  fromSeq?: number;
  toSeq?: number;
  /** Number of summaries created in this run (>=1 when state is 'created'). */
  createdCount?: number;
}

/**
 * Incremental, failure-isolated conversation summarization for local context.
 *
 * Production uses the independent `summary` model slot first, then the chat
 * model as a compatibility fallback. If neither slot is configured this
 * returns `noop` instead of fabricating a local "summary" and pretending the
 * model path succeeded.
 */
export class SummaryBuilder {
  private readonly maxMessages: number;

  constructor(private readonly options: SummaryBuilderOptions) {
    this.maxMessages = Math.max(8, Math.min(120, options.maxMessages ?? 60));
  }

  async build(signal?: AbortSignal): Promise<SummaryBuildResult> {
    if (signal?.aborted) throw signal.reason ?? new Error('summary build aborted');
    const covered = await this.options.summaries.coveredUpTo();
    const maxSeq = await this.options.messages.maxSeq();
    if (maxSeq <= covered) return { state: 'noop' };
    const messages = (await this.options.messages.range(covered + 1, maxSeq))
      .filter((message) => message.status !== 'failed' && !message.meta.withdrawnAt && messageText(message))
      .sort((a, b) => a.seq - b.seq);
    if (messages.length === 0) return { state: 'noop' };

    // Chunk the uncovered range so every message is covered by some summary.
    // A single summary may only span maxMessages messages; slicing the tail
    // and writing a partial fromSeq would permanently drop the skipped range.
    const chunks: ChatMessage[][] = [];
    for (let index = 0; index < messages.length; index += this.maxMessages) {
      chunks.push(messages.slice(index, index + this.maxMessages));
    }

    const provider = await this.resolveProvider();
    if (!provider?.configured) return { state: 'noop' };

    let last: SummaryRow | undefined;
    let createdCount = 0;
    for (const chunk of chunks) {
      if (signal?.aborted) throw signal.reason ?? new Error('summary build aborted');
      const fromSeq = chunk[0]!.seq;
      const toSeq = chunk.at(-1)!.seq;
      const result = await provider.complete({
        system: '你是 SOOYA 的本地对话摘要器。保留事实、偏好、未完成事项、情绪和上下文关系；不要编造。只输出简洁中文摘要。',
        messages: [{ role: 'user', content: [{ type: 'text', text: formatMessages(chunk) }] }],
        maxTokens: 900,
        temperature: 0,
        signal
      });
      const content = result.text.trim();
      if (!content) continue;
      last = await this.options.summaries.create({ fromSeq, toSeq, content: content.slice(0, 8000), model: result.model });
      createdCount += 1;
    }

    if (!last) return { state: 'noop' };
    return { state: 'created', summary: last, fromSeq: last.from_seq, toSeq: last.to_seq, createdCount };
  }

  /** Returns the first usable summary slot: independent summary, then chat. */
  async resolveProvider(): Promise<ChatProvider | null> {
    const summary = await resolveProvider(this.options.summaryProvider);
    if (summary?.configured) return summary;
    const chat = await resolveProvider(this.options.chatProvider ?? this.options.provider);
    return chat?.configured ? chat : null;
  }
}

function formatMessages(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.role === 'user' ? '用户' : message.role === 'assistant' ? 'SOOYA' : '系统'}：${messageText(message).slice(0, 1200)}`).join('\n');
}

async function resolveProvider(value: ProviderResolver): Promise<ChatProvider | null> {
  if (typeof value === 'function') return await value();
  return value ?? null;
}
