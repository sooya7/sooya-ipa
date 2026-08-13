import type { MemoryRepo } from '../db/memory.repo.js';
import type { MessageRepo } from '../db/message.repo.js';
import type { ReplyBatchRepo } from '../db/reply-batch.repo.js';
import type { ChatProvider, ChatRequest, ChatTurn } from '../providers/types.js';
import type { ToolCallRuntime } from '../tools/tool-runtime.js';
import type { ChatMessage } from './types.js';

export interface ReplyCoordinatorOptions {
  messages: MessageRepo;
  batches: ReplyBatchRepo;
  memory: MemoryRepo;
  provider?: ChatProvider | null;
  providerFactory?: () => Promise<ChatProvider | null>;
  toolRuntime?: ToolCallRuntime;
  now?: () => Date;
  debounceMs?: number;
  emit: (type: string, data: Record<string, unknown>) => void;
}

/**
 * Durable local reply worker. Admission is persisted by LocalCore first; this
 * class only claims a batch after that write succeeds, so a suspended app can
 * safely retry the work on the next foreground transition.
 */
export class ReplyCoordinator {
  private readonly active = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;

  constructor(private readonly options: ReplyCoordinatorOptions) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 1200);
  }

  schedule(batchId: string, revision = 0): void {
    const existing = this.timers.get(batchId);
    if (existing) clearTimeout(existing);
    this.timers.set(batchId, setTimeout(() => {
      this.timers.delete(batchId);
      void this.run(batchId, revision);
    }, this.debounceMs));
  }

  async run(batchId: string, revision = 0): Promise<void> {
    if (this.active.has(batchId)) return;
    this.active.add(batchId);
    try {
      const provider = this.options.provider ?? await this.options.providerFactory?.() ?? null;
      if (!provider || !provider.configured) return;
      const batch = await this.options.batches.markRunning(batchId);
      if (!batch || batch.status !== 'running') return;
      this.options.emit('reply.started', { batchId, revision, attempt: batch.attempts });
      const ids = await this.options.batches.messageIds(batchId);
      const sourceMessages = (await Promise.all(ids.map((id) => this.options.messages.get(id)))).filter(isMessage);
      const latestUser = [...sourceMessages].reverse().find((message) => message.role === 'user');
      if (!latestUser) throw new Error('reply batch has no user message');
      const recent = await this.options.messages.recent(32);
      const turns = await this.buildTurns(recent, latestUser);
      const request: ChatRequest = {
        system: await this.systemPrompt(latestUser),
        messages: turns,
        maxTokens: 2048,
        temperature: 0.7
      };
      const finalRequest = this.options.toolRuntime
        ? await this.options.toolRuntime.prepare(provider, request, { phase: 'reply', batchId, revision })
        : request;
      const result = await provider.complete(finalRequest);
      const text = result.text.trim() || '我刚刚没有生成可见回复。';
      const created = await this.options.messages.create({
        role: 'assistant', status: 'sending', replyTo: latestUser.id, batchId,
        parts: [{ type: 'text', text }],
        meta: { batchId, revision, model: result.model, finishReason: result.finishReason ?? null, usage: result.usage ?? null }
      });
      await this.options.messages.setStatus(created.message.id, 'sent');
      const assistant = await this.options.messages.get(created.message.id);
      if (!assistant) throw new Error('assistant message was not persisted');
      await this.options.batches.complete(batchId, assistant.id);
      this.options.emit('message.received', { message: assistant });
      this.options.emit('reply.completed', { batchId, revision, message: assistant, model: result.model });
      await this.commitMemory(batchId, revision, latestUser, text).catch((error) => {
        this.options.emit('memory.commit.failed', { batchId, revision, error: error instanceof Error ? error.message : String(error) });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.options.batches.fail(batchId, message).catch(() => undefined);
      this.options.emit('reply.failed', { batchId, revision, error: message.slice(0, 500) });
    } finally {
      this.active.delete(batchId);
    }
  }

  async recover(): Promise<void> {
    const open = await this.options.batches.latestOpen();
    if (open) this.schedule(open.id, 0);
  }

  private async buildTurns(messages: ChatMessage[], latestUser: ChatMessage): Promise<ChatTurn[]> {
    const turns: ChatTurn[] = [];
    for (const message of messages) {
      if (message.status === 'failed' || message.meta.withdrawnAt) continue;
      const text = textOf(message);
      if (!text) continue;
      turns.push({ role: message.role === 'system' ? 'system' : message.role, content: [{ type: 'text', text }] });
    }
    const memories = await this.options.memory.searchFts(textOf(latestUser), 8).catch(() => []);
    if (memories.length) {
      turns.unshift({ role: 'system', content: [{ type: 'text', text: `相关本地记忆（仅作参考）：\n${memories.map((item) => `- ${item.content}`).join('\n')}` }] });
    }
    return turns.slice(-40);
  }

  private async systemPrompt(latestUser: ChatMessage): Promise<string> {
    const text = textOf(latestUser);
    return [
      '你是 SOOYA，运行在用户的 iPhone 本地。',
      '回答自然、简洁、真诚；不要声称自己访问了不存在的服务器服务。',
      '除非用户明确要求，不要主动发送消息、推送通知或制造任务。',
      text ? `当前用户消息：${text}` : ''
    ].filter(Boolean).join('\n');
  }

  private async commitMemory(batchId: string, revision: number, user: ChatMessage, assistantText: string): Promise<void> {
    const userText = textOf(user);
    const candidates = extractMemoryCandidates(userText).map((candidate) => ({ ...candidate, sourceHash: `${batchId}:${revision}:${candidate.content}` }));
    await this.options.memory.commit({ batchId, revision, userText, assistantText }, candidates);
  }
}

function isMessage(value: ChatMessage | undefined): value is ChatMessage { return value !== undefined; }

export function textOf(message: ChatMessage): string {
  return message.content.map((part) => part.text ?? part.transcript ?? '').filter(Boolean).join('\n').trim();
}

function extractMemoryCandidates(text: string): Array<{ kind: 'profile' | 'preference' | 'relationship' | 'project' | 'event' | 'summary'; content: string; importance: number; confidence: number }> {
  const normalized = text.replace(/[\r\n]+/gu, ' ').trim();
  if (!normalized || normalized.length > 300) return [];
  const match = normalized.match(/(?:请)?(?:记住|别忘了|不要忘记)[：: ]*(.+)$/u);
  if (match?.[1]) return [{ kind: 'summary', content: match[1].trim(), importance: 0.8, confidence: 0.8 }];
  if (/^(?:我喜欢|我不喜欢|我偏好|我讨厌)/u.test(normalized)) return [{ kind: 'preference', content: normalized, importance: 0.65, confidence: 0.7 }];
  if (/^(?:我是|我叫|我的名字是|我住在|我在)/u.test(normalized)) return [{ kind: 'profile', content: normalized, importance: 0.7, confidence: 0.72 }];
  return [];
}
