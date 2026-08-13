import type { BootstrapInfo, MessageContext, MessageSearchHit, Moment } from '../lib/api.js';
import type { MessagePage, SooyaClient } from '../lib/sooyaClient.js';
import type { ChatMessage, MediaRef, StickerInfo, WorldPresence } from '../lib/types.js';
import { LocalEventBus, type LocalEventListener } from './LocalEventBus.js';

export interface TestLocalClientOptions {
  now?: () => Date;
  messages?: ChatMessage[];
  moments?: Moment[];
  stickers?: StickerInfo[];
}

const EMPTY_PRESENCE: WorldPresence = {
  city: null,
  location: null,
  travel: null,
  weather: null,
  updatedAt: '1970-01-01T00:00:00.000Z'
};

/** Deterministic in-memory client for browser unit tests and server-free E2E. */
export class TestLocalClient implements SooyaClient {
  private readonly bus: LocalEventBus;
  private readonly now: () => Date;
  private readonly storedMessages: ChatMessage[];
  private readonly storedMoments: Moment[];
  private readonly storedStickers: StickerInfo[];
  private readonly media = new Map<string, MediaRef>();
  private nextMessageSeq: number;
  private nextId = 1;

  constructor(options: TestLocalClientOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.bus = new LocalEventBus({ now: this.now });
    this.storedMessages = structuredClone(options.messages ?? []);
    this.storedMoments = structuredClone(options.moments ?? []);
    this.storedStickers = structuredClone(options.stickers ?? []);
    this.nextMessageSeq = this.storedMessages.reduce((max, item) => Math.max(max, item.seq), 0) + 1;
  }

  subscribe(listener: LocalEventListener): () => void { return this.bus.subscribe(listener); }

  async bootstrap(): Promise<BootstrapInfo> {
    const page = await this.messages({ limit: 30 });
    const life = await this.life();
    const presence = await this.presence();
    return {
      conversation: {
        conversationId: 'main',
        persona: { name: 'SOOYA', avatar: '/avatars/sooya.svg', userAvatar: '/avatars/user.svg', tagline: '在的' },
        messageCount: this.storedMessages.length,
        lastSeq: this.nextMessageSeq - 1,
        lastEventSeq: page.lastEventSeq
      },
      messages: page,
      stickers: structuredClone(this.storedStickers),
      life,
      presence
    };
  }

  async messages(options: { limit?: number; before?: number; since?: number } = {}): Promise<MessagePage> {
    const limit = Math.max(1, options.limit ?? 30);
    let rows = [...this.storedMessages].sort((a, b) => a.seq - b.seq);
    if (options.before !== undefined) rows = rows.filter((item) => item.seq < options.before!);
    if (options.since !== undefined) rows = rows.filter((item) => item.seq > options.since!);
    const selected = options.since !== undefined ? rows.slice(0, limit) : rows.slice(-limit);
    return {
      messages: structuredClone(selected),
      hasMore: rows.length > selected.length,
      nextSince: selected.at(-1)?.seq,
      lastEventSeq: this.bus.lastSequence,
      lastMessageSeq: this.nextMessageSeq - 1,
      oldestSeq: selected[0]?.seq ?? null
    };
  }

  async messageSearch(query: string, options: { limit?: number; cursor?: string | null } = {}): Promise<{ hits: MessageSearchHit[]; nextCursor: string | null }> {
    const needle = query.trim().toLocaleLowerCase();
    const offset = Math.max(0, Number(options.cursor ?? 0) || 0);
    const limit = Math.max(1, options.limit ?? 30);
    const all = this.storedMessages.flatMap((message) => {
      const part = message.content.find((item) => item.text?.toLocaleLowerCase().includes(needle));
      return part ? [{ message: structuredClone(message), snippet: part.text ?? '', matchedPartId: part.id }] : [];
    });
    const hits = all.slice(offset, offset + limit);
    return { hits, nextCursor: offset + hits.length < all.length ? String(offset + hits.length) : null };
  }

  async messagesByDate(date: string, timeZone: string, limit = 200): Promise<{ date: string; timeZone: string; messages: ChatMessage[]; hasMore: boolean }> {
    const matching = this.storedMessages.filter((message) => message.createdAt.slice(0, 10) === date);
    return { date, timeZone, messages: structuredClone(matching.slice(0, limit)), hasMore: matching.length > limit };
  }

  async messageContext(id: string, options: { before?: number; after?: number } = {}): Promise<MessageContext> {
    const index = this.storedMessages.findIndex((message) => message.id === id);
    if (index < 0) throw Object.assign(new Error('message not found'), { status: 404 });
    const before = options.before ?? 20;
    const after = options.after ?? 20;
    return {
      target: structuredClone(this.storedMessages[index]!),
      messages: structuredClone(this.storedMessages.slice(Math.max(0, index - before), index + after + 1)),
      hasOlder: index > before,
      hasNewer: index + after + 1 < this.storedMessages.length
    };
  }

  async send(payload: { clientMsgId: string; content: unknown[]; directives?: Record<string, boolean>; replyTo?: string }): Promise<{ message: ChatMessage; duplicate: boolean; replyPending: boolean }> {
    const duplicate = this.storedMessages.find((message) => message.clientMsgId === payload.clientMsgId);
    if (duplicate) return { message: structuredClone(duplicate), duplicate: true, replyPending: true };
    const now = this.now().toISOString();
    const message: ChatMessage = {
      id: `message_${this.nextId++}`,
      conversationId: 'main',
      role: 'user',
      createdAt: now,
      updatedAt: now,
      seq: this.nextMessageSeq++,
      status: 'sent',
      clientMsgId: payload.clientMsgId,
      replyTo: payload.replyTo ?? null,
      content: payload.content.map((raw, index) => {
        const item = raw as Record<string, unknown>;
        return {
          id: `part_${this.nextId++}_${index}`,
          type: String(item.type ?? 'text') as ChatMessage['content'][number]['type'],
          text: typeof item.text === 'string' ? item.text : null,
          mediaId: typeof item.mediaId === 'string' ? item.mediaId : null,
          status: 'sent' as const
        };
      })
    };
    this.storedMessages.push(message);
    this.bus.emit('message.received', { message: structuredClone(message) });
    return { message: structuredClone(message), duplicate: false, replyPending: true };
  }

  async withdraw(id: string): Promise<{ message: ChatMessage }> {
    const message = this.storedMessages.find((item) => item.id === id);
    if (!message) throw Object.assign(new Error('message not found'), { status: 404 });
    message.status = 'failed';
    message.error = 'withdrawn';
    message.updatedAt = this.now().toISOString();
    this.bus.emit('message.updated', { message: structuredClone(message) });
    return { message: structuredClone(message) };
  }

  async retryBatch(id: string): Promise<{ batchId: string; revision: number; status: string }> {
    const result = { batchId: id, revision: 1, status: 'pending' };
    this.bus.emit('reply.batch.queued', result);
    return result;
  }

  async upload(files: Array<{ file: File | Blob; field: 'image' | 'file'; name?: string }>): Promise<{ media: MediaRef[]; failed: Array<{ filename: string; error: string; code?: string }> }> {
    const saved = files.map((input) => {
      const id = `media_${this.nextId++}`;
      const item: MediaRef = {
        id,
        kind: input.field,
        mime: input.file.type || 'application/octet-stream',
        bytes: input.file.size,
        url: `local-media://${id}`,
        name: input.name ?? (input.file instanceof File ? input.file.name : null)
      };
      this.media.set(id, item);
      return structuredClone(item);
    });
    return { media: saved, failed: [] };
  }

  async moments(limit = 50): Promise<{ moments: Moment[]; hasMore: boolean }> {
    return { moments: structuredClone(this.storedMoments.slice(0, limit)), hasMore: this.storedMoments.length > limit };
  }

  addMoment(input: { text: string; activity: string; createdAt?: string }): Moment {
    const moment: Moment = {
      id: `moment_${this.nextId++}`,
      text: input.text,
      activity: input.activity,
      image: null,
      location: null,
      weather: null,
      liked: false,
      createdAt: input.createdAt ?? this.now().toISOString()
    };
    this.storedMoments.unshift(moment);
    this.bus.emit('moment.created', { moment: structuredClone(moment) });
    return structuredClone(moment);
  }

  async likeMoment(id: string, liked: boolean): Promise<{ moment: Moment }> {
    const moment = this.storedMoments.find((item) => item.id === id);
    if (!moment) throw Object.assign(new Error('moment not found'), { status: 404 });
    moment.liked = liked;
    return { moment: structuredClone(moment) };
  }

  async stickerSearch(options: { scope?: 'recent' | 'favorite' | 'all'; q?: string; limit?: number; cursor?: string | null } = {}): Promise<{ stickers: StickerInfo[]; total: number; nextCursor: string | null }> {
    const query = options.q?.trim().toLocaleLowerCase() ?? '';
    let rows = this.storedStickers.filter((item) => (!query || `${item.name} ${item.emotion} ${item.tags.join(' ')}`.toLocaleLowerCase().includes(query)) && (options.scope !== 'favorite' || item.favorite));
    const offset = Math.max(0, Number(options.cursor ?? 0) || 0);
    const total = rows.length;
    rows = rows.slice(offset, offset + (options.limit ?? 60));
    return { stickers: structuredClone(rows), total, nextCursor: offset + rows.length < total ? String(offset + rows.length) : null };
  }

  async life() {
    const now = this.now().toISOString();
    return { activity: '在家休息', kind: 'rest', mood: 'calm', startedAt: now, endsAt: now, recent: [] };
  }

  async presence(): Promise<WorldPresence> {
    return { ...structuredClone(EMPTY_PRESENCE), updatedAt: this.now().toISOString() };
  }

  async capabilities() {
    return { capabilities: {}, stickers: { available: this.storedStickers.length, total: this.storedStickers.length } };
  }
}

