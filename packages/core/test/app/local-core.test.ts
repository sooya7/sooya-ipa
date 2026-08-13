import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalCore } from '../../src/app/local-core.js';
import type { MediaPlatform, MediaRecord, MediaSaveRequest } from '../../src/platform/media.js';
import type { SecretsPlatform } from '../../src/platform/secrets.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { NodeLocalDatabase } from '../db/node-local-database.js';
import { MessageRepo } from '../../src/db/index.js';

class MemoryMediaStore implements MediaPlatform {
  private next = 1;
  private readonly records = new Map<string, { record: MediaRecord; data: Uint8Array }>();

  async save(request: MediaSaveRequest): Promise<MediaRecord> {
    const id = `mem-media-${this.next++}`;
    const record: MediaRecord = {
      id,
      kind: request.kind,
      mime: request.mime ?? 'application/octet-stream',
      bytes: request.data.byteLength,
      name: request.name
    };
    this.records.set(id, { record, data: new Uint8Array(request.data) });
    return record;
  }

  async read(id: string): Promise<{ record: MediaRecord; data: Uint8Array } | null> {
    const entry = this.records.get(id);
    return entry ? { record: entry.record, data: new Uint8Array(entry.data) } : null;
  }

  async remove(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

class MemorySecrets implements SecretsPlatform {
  private readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async remove(key: string): Promise<void> { this.values.delete(key); }
}

describe('LocalCore', () => {
  let db: NodeLocalDatabase;
  let core: LocalCore;
  let secrets: MemorySecrets;

  beforeEach(async () => {
    db = new NodeLocalDatabase();
    await migrateDatabase(db);
    secrets = new MemorySecrets();
    core = new LocalCore({ db, mediaStore: new MemoryMediaStore(), secrets });
  });

  afterEach(async () => await db.close());

  it('bootstraps an empty conversation with life and presence', async () => {
    await core.lifeRepo.advance({ activity: '早餐', kind: 'meal', mood: 'happy', startedAt: '2026-08-13T01:00:00.000Z', endsAt: '2026-08-13T01:30:00.000Z' });
    const info = await core.bootstrap();

    expect(info.conversation.conversationId).toBe('main');
    expect(info.conversation.messageCount).toBe(0);
    expect(info.messages.messages).toEqual([]);
    expect(info.stickers).toEqual([]);
    expect(info.life.activity).toBe('早餐');
    expect(info.presence.location).toBeNull();
  });

  it('sends a user message, persists it and emits ordered local events', async () => {
    const seen: string[] = [];
    core.subscribe((event) => seen.push(event.type));

    const result = await core.send({
      clientMsgId: 'client-1',
      content: [{ type: 'text', text: '你好' }]
    });

    expect(result.duplicate).toBe(false);
    expect(result.replyPending).toBe(true);
    expect(result.message.role).toBe('user');
    expect(result.message.content[0]).toMatchObject({ type: 'text', text: '你好' });
    expect(seen).toEqual(['message.received', 'reply.queued']);

    const page = await core.messages({ limit: 10 });
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]!.clientMsgId).toBe('client-1');

    // Same clientMsgId is deduped, not re-created.
    const again = await core.send({ clientMsgId: 'client-1', content: [{ type: 'text', text: '你好' }] });
    expect(again.duplicate).toBe(true);
    expect(again.message.id).toBe(result.message.id);
  });

  it('searches messages and returns context around a target', async () => {
    const repo = new MessageRepo(db);
    await repo.create({ role: 'user', parts: [{ type: 'text', text: '今天想吃草莓蛋糕' }] });
    const assistant = await repo.create({ role: 'assistant', parts: [{ type: 'text', text: '好的，草莓蛋糕' }] });

    const hits = await core.messageSearch('草莓蛋糕');
    expect(hits.hits.length).toBe(2);
    expect(hits.hits.some((hit) => hit.message.role === 'user')).toBe(true);

    const context = await core.messageContext(assistant.message.id);
    expect(context.target.id).toBe(assistant.message.id);
    expect(context.messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('groups messages by local date in the requested time zone', async () => {
    const repo = new MessageRepo(db);
    // 2026-08-12T23:30:00Z == 2026-08-13 07:30 in Asia/Shanghai
    await repo.create({ role: 'user', parts: [{ type: 'text', text: '深夜消息' }] });
    await db.run(`UPDATE messages SET created_at = '2026-08-12T23:30:00.000Z' WHERE role = 'user'`);

    const shanghai = await core.messagesByDate('2026-08-13', 'Asia/Shanghai');
    expect(shanghai.messages).toHaveLength(1);
    expect(shanghai.messages[0]!.content[0]).toMatchObject({ text: '深夜消息' });

    const utc = await core.messagesByDate('2026-08-13', 'UTC');
    expect(utc.messages).toHaveLength(0);
  });

  it('creates, lists and likes moments', async () => {
    const created = await core.momentsRepo.create({ candidateId: 'candidate-1', text: '早餐时间', activity: '早餐' });

    const { moments } = await core.moments();
    expect(moments).toHaveLength(1);
    expect(moments[0]).toMatchObject({ id: created.id, text: '早餐时间', liked: false });

    const liked = await core.likeMoment(created.id, true);
    expect(liked.moment.liked).toBe(true);
  });

  it('uploads media bytes through the platform store', async () => {
    const { media, failed } = await core.upload([
      { name: 'photo.jpg', mime: 'image/jpeg', bytes: new TextEncoder().encode('fake-jpeg'), field: 'image' }
    ]);

    expect(failed).toEqual([]);
    expect(media).toHaveLength(1);
    expect(media[0]!.kind).toBe('image');
    expect(media[0]!.mime).toBe('image/jpeg');
    expect(media[0]!.url).toBe(`media://${media[0]!.id}`);
  });

  it('reports secret-based capability status', async () => {
    const empty = await core.capabilities();
    expect(empty.capabilities.chat!.configured).toBe(false);
    expect(empty.stickers).toMatchObject({ available: 0, total: 0 });

    await secrets.set('provider.chat.key', 'sk-test');
    const configured = await core.capabilities();
    expect(configured.capabilities.chat!.configured).toBe(true);
  });

  it('withdraws a fresh user message', async () => {
    const { message } = await core.send({ clientMsgId: 'w-1', content: [{ type: 'text', text: '撤回我' }] });
    const result = await core.withdraw(message.id);
    expect(result.message.meta.withdrawnAt).toBeTruthy();
    expect(result.message.content[0]).toMatchObject({ type: 'text', text: '[消息已撤回]' });
  });
});
