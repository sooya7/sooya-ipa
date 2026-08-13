import type { MemoryProvider } from '../memory/types.js';
import type { MessageRepo } from '../db/message.repo.js';
import type { ReplyBatchRepo } from '../db/reply-batch.repo.js';
import type { ChatChunk, ChatProvider, ChatRequest, ChatTurn } from '../providers/types.js';
import type { ToolCallRuntime } from '../tools/tool-runtime.js';
import type { ChatMessage } from './types.js';
import type { ContextBuilder } from './context-builder.js';

export interface ReplyCoordinatorOptions {
  messages: MessageRepo;
  batches: ReplyBatchRepo;
  memory: MemoryProvider;
  provider?: ChatProvider | null;
  providerFactory?: () => Promise<ChatProvider | null>;
  toolRuntime?: ToolCallRuntime;
  contextBuilder?: ContextBuilder;
  now?: () => Date;
  debounceMs?: number;
  emit: (type: string, data: Record<string, unknown>) => void;
}

interface ActiveGeneration {
  controller: AbortController;
  revision: number;
  assistantId?: string;
}

/**
 * Durable local reply worker. Provider output is persisted incrementally and
 * published through the same event bus the React shell already consumes.
 * Every write is fenced by (batchId, revision), so an interrupted generation
 * can never complete or commit memory after a newer user message arrives.
 */
export class ReplyCoordinator {
  private readonly active = new Map<string, ActiveGeneration>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly debounceMs: number;

  constructor(private readonly options: ReplyCoordinatorOptions) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 1200);
  }

  schedule(batchId: string, revision = 0): void {
    const running = this.active.get(batchId);
    if (running && revision > running.revision) {
      running.controller.abort(new SupersededReplyError('new user message superseded this generation'));
      if (running.assistantId) void this.options.messages.setStatus(running.assistantId, 'failed', 'superseded by newer revision');
      this.options.emit('reply.interrupted', { batchId, revision: running.revision, reason: 'newer_revision' });
    }
    const existing = this.timers.get(batchId);
    if (existing) clearTimeout(existing);
    this.timers.set(batchId, setTimeout(() => {
      this.timers.delete(batchId);
      void this.run(batchId, revision);
    }, this.debounceMs));
  }

  interruptAll(reason = 'app_inactive'): void {
    for (const [batchId, generation] of this.active) {
      generation.controller.abort(new Error(reason));
      if (generation.assistantId) void this.options.messages.setStatus(generation.assistantId, 'failed', reason);
      this.options.emit('reply.interrupted', { batchId, revision: generation.revision, reason });
    }
  }

  async run(batchId: string, requestedRevision = 0): Promise<void> {
    if (this.active.has(batchId)) return;
    const initial = await this.options.batches.get(batchId);
    if (!initial) return;
    const revision = requestedRevision > 0 && requestedRevision === initial.revision ? requestedRevision : initial.revision;
    const controller = new AbortController();
    const generation: ActiveGeneration = { controller, revision };
    this.active.set(batchId, generation);
    let assistantId: string | undefined;
    try {
      const provider = this.options.provider ?? await this.options.providerFactory?.() ?? null;
      if (!provider || !provider.configured) return;
      const batch = await this.options.batches.markRunning(batchId, revision);
      if (!batch || batch.revision !== revision || !['generating', 'running'].includes(batch.status)) return;
      this.options.emit('reply.started', { batchId, revision, attempt: batch.attempts });
      const ids = await this.options.batches.messageIds(batchId);
      const sourceMessages = (await Promise.all(ids.map((id) => this.options.messages.get(id)))).filter(isMessage);
      const latestUser = [...sourceMessages].reverse().find((message) => message.role === 'user');
      if (!latestUser) throw new Error('reply batch has no user message');
      const recent = await this.options.messages.recent(32);
      const context = this.options.contextBuilder
        ? await this.options.contextBuilder.build({ recent, latestUser })
        : { system: await this.systemPrompt(latestUser), turns: await this.buildTurns(recent, latestUser) };
      const request: ChatRequest = {
        system: context.system,
        messages: context.turns,
        maxTokens: 2048,
        temperature: 0.7,
        signal: controller.signal
      };
      const finalRequest = this.options.toolRuntime
        ? await this.options.toolRuntime.prepare(provider, request, { phase: 'reply', batchId, revision, signal: controller.signal })
        : request;
      if (controller.signal.aborted) throw controller.signal.reason ?? new SupersededReplyError('reply aborted');

      const created = await this.options.messages.create({
        role: 'assistant', status: 'sending', replyTo: latestUser.id, batchId,
        parts: [{ type: 'text', text: '' }],
        meta: { batchId, revision, partial: true }
      });
      assistantId = created.message.id;
      generation.assistantId = assistantId;
      const partId = created.message.content[0]?.id;
      if (!partId) throw new Error('assistant text part was not persisted');
      let text = '';
      let write = Promise.resolve();
      const publish = (chunk: ChatChunk): void => {
        if (controller.signal.aborted) return;
        if (chunk.delta) {
          text += chunk.delta;
          this.options.emit('reply.text.delta', { batchId, revision, messageId: assistantId, delta: chunk.delta, text });
          write = write.then(() => this.options.messages.updatePart(partId, { text }));
        }
        if (chunk.toolCall) this.options.emit('reply.tool.delta', { batchId, revision, messageId: assistantId, toolCall: chunk.toolCall });
        if (chunk.finishReason) this.options.emit('reply.finish', { batchId, revision, finishReason: chunk.finishReason });
      };
      const result = await provider.stream(finalRequest, publish);
      await write;
      if (controller.signal.aborted || await this.options.batches.currentRevision(batchId) !== revision) {
        throw new SupersededReplyError('reply revision is no longer current');
      }
      const finalText = text || result.text || '';
      if (!finalText.trim()) throw new Error('provider returned an empty reply');
      if (finalText !== text) {
        text = finalText;
        await this.options.messages.updatePart(partId, { text });
      }
      await this.options.messages.updateMeta(assistantId, { batchId, revision, partial: false, model: result.model, finishReason: result.finishReason ?? null, usage: result.usage ?? null });
      await this.options.messages.setStatus(assistantId, 'sent');
      const assistant = await this.options.messages.get(assistantId);
      if (!assistant) throw new Error('assistant message was not persisted');
      if (!await this.options.batches.complete(batchId, assistant.id, revision)) throw new SupersededReplyError('reply completion lost its revision fence');
      this.options.emit('message.received', { message: assistant });
      this.options.emit('reply.completed', { batchId, revision, message: assistant, model: result.model });
      await this.commitMemory(batchId, revision, latestUser, text, controller.signal).catch((error) => {
        if (!controller.signal.aborted) this.options.emit('memory.commit.failed', { batchId, revision, error: error instanceof Error ? error.message : String(error) });
      });
    } catch (error) {
      const superseded = error instanceof SupersededReplyError || controller.signal.aborted;
      if (assistantId) await this.options.messages.setStatus(assistantId, 'failed', superseded ? 'superseded' : error instanceof Error ? error.message : String(error)).catch(() => undefined);
      if (superseded) {
        await this.options.batches.supersede(batchId, revision).catch(() => undefined);
        this.options.emit('reply.interrupted', { batchId, revision, reason: 'superseded' });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        await this.options.batches.fail(batchId, message, revision, 'provider_failed').catch(() => undefined);
        this.options.emit('reply.failed', { batchId, revision, error: message.slice(0, 500) });
      }
    } finally {
      if (this.active.get(batchId)?.controller === controller) this.active.delete(batchId);
    }
  }

  async recover(): Promise<void> {
    const open = await this.options.batches.latestOpen();
    if (open) this.schedule(open.id, open.revision);
  }

  private async buildTurns(messages: ChatMessage[], latestUser: ChatMessage): Promise<ChatTurn[]> {
    const turns: ChatTurn[] = [];
    for (const message of messages) {
      if (message.status === 'failed' || message.meta.withdrawnAt) continue;
      const text = textOf(message);
      if (!text) continue;
      turns.push({ role: message.role === 'system' ? 'system' : message.role, content: [{ type: 'text', text }] });
    }
    const memories = await this.options.memory.search(textOf(latestUser), 8).catch(() => []);
    if (memories.length) turns.unshift({ role: 'system', content: [{ type: 'text', text: `相关本地记忆（仅作参考）：\n${memories.map((item) => `- ${item.content}`).join('\n')}` }] });
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

  private async commitMemory(batchId: string, revision: number, user: ChatMessage, assistantText: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const userText = textOf(user);
    await this.options.memory.commit({ batchId, revision, userText, assistantText, signal });
  }
}

class SupersededReplyError extends Error { override name = 'SupersededReplyError'; }

function isMessage(value: ChatMessage | undefined): value is ChatMessage { return value !== undefined; }

export function textOf(message: ChatMessage): string {
  return message.content.map((part) => part.text ?? part.transcript ?? '').filter(Boolean).join('\n').trim();
}
