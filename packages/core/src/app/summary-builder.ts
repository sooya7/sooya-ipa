import type { MessageRepo } from '../db/message.repo.js';
import type { SummaryRepo, SummaryRow } from '../db/misc.repo.js';
import type { ChatProvider } from '../providers/types.js';
import type { ChatMessage } from './types.js';

export interface SummaryBuilderOptions {
  messages: MessageRepo;
  summaries: SummaryRepo;
  provider?: ChatProvider | null | (() => Promise<ChatProvider | null>);
  maxMessages?: number;
}

export interface SummaryBuildResult {
  state: 'created' | 'noop';
  summary?: SummaryRow;
  fromSeq?: number;
  toSeq?: number;
}

/** Incremental, failure-isolated conversation summarization for local context. */
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
      .slice(-this.maxMessages);
    if (messages.length === 0) return { state: 'noop' };
    const fromSeq = messages[0]!.seq;
    const toSeq = messages.at(-1)!.seq;
    const provider = typeof this.options.provider === 'function' ? await this.options.provider() : this.options.provider;
    let content: string;
    let model: string | null = null;
    if (provider?.configured) {
      try {
        const result = await provider.complete({
          system: '你是 SOOYA 的本地对话摘要器。保留事实、偏好、未完成事项、情绪和上下文关系；不要编造。只输出简洁中文摘要。',
          messages: [{ role: 'user', content: [{ type: 'text', text: formatMessages(messages) }] }],
          maxTokens: 900,
          temperature: 0,
          signal
        });
        content = result.text.trim();
        model = result.model;
      } catch {
        content = fallbackSummary(messages);
      }
    } else content = fallbackSummary(messages);
    if (!content) return { state: 'noop' };
    const summary = await this.options.summaries.create({ fromSeq, toSeq, content: content.slice(0, 8000), model });
    return { state: 'created', summary, fromSeq, toSeq };
  }
}

function formatMessages(messages: ChatMessage[]): string {
  return messages.map((message) => `${message.role === 'user' ? '用户' : message.role === 'assistant' ? 'SOOYA' : '系统'}：${messageText(message).slice(0, 1200)}`).join('\n');
}

function fallbackSummary(messages: ChatMessage[]): string {
  return formatMessages(messages).slice(0, 4000);
}

function messageText(message: ChatMessage): string {
  return message.content.map((part) => part.text ?? part.transcript ?? '').filter(Boolean).join('\n').trim();
}
