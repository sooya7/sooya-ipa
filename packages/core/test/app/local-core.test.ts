import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalCore } from '../../src/app/local-core.js';
import type { MediaPlatform, MediaRecord, MediaSaveRequest } from '../../src/platform/media.js';
import type { SecretsPlatform } from '../../src/platform/secrets.js';
import type { HttpPlatform, HttpResponse } from '../../src/platform/http.js';
import type { McpPlatform } from '../../src/platform/mcp.js';
import type { ChatProvider } from '../../src/providers/types.js';
import { createWebSearch } from '../../src/providers/web-search.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { NodeLocalDatabase } from '../db/node-local-database.js';
import { MessageRepo } from '../../src/db/index.js';

function waitForEvent(core: LocalCore, type: string, timeoutMs = 8000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`timeout waiting for ${type}`)); }, timeoutMs);
    const unsubscribe = core.subscribe((event) => {
      if (event.type === type) { clearTimeout(timer); unsubscribe(); resolve(event.data); }
    });
  });
}

/** Fake HttpPlatform serving the doubao search endpoint (and inert weather). */
function searchHttp(recorded: { requests: Array<{ url: string; secretRef: string | null }> }): HttpPlatform {
  return {
    async request(input) {
      recorded.requests.push({ url: String(input.url), secretRef: input.secretRef ?? null });
      const body = new TextEncoder().encode(JSON.stringify({
        Result: { WebResults: [{ Title: '新闻一', Url: 'https://news.example/1', Summary: '第一条摘要' }] }
      }));
      const response: HttpResponse = { status: 200, headers: { 'content-type': 'application/json' }, body };
      return response;
    },
    async stream() { throw new Error('not used'); }
  };
}

function fakeChatProvider(capturedSystems: string[]): ChatProvider {
  return {
    name: 'fake-chat',
    configured: true,
    supportsTools: false,
    complete: async () => ({ text: 'ok', model: 'fake' }),
    stream: async (request, onChunk) => {
      capturedSystems.push(request.system ?? '');
      onChunk({ delta: '这是联网回复' });
      return { text: '这是联网回复', model: 'fake' };
    },
    inspectHealth: async () => ({ capability: 'chat', configured: true, ok: true, provider: 'fake', checkedAt: new Date().toISOString() })
  };
}

const WEB_SEARCH_PATCH = {
  enabled: true,
  providers: ['doubao', 'tavily'],
  maxResults: 5,
  timeoutMs: 15000,
  doubao: { edition: 'custom', baseUrl: 'https://doubao.test', apiKey: 'doubao-key' },
  tavily: { baseUrl: 'https://tavily.test', apiKey: 'tavily-key' }
};

async function saveWebSearch(core: LocalCore): Promise<void> {
  await core.adminRequest('/api/admin/models', { method: 'PUT', body: { webSearch: WEB_SEARCH_PATCH } });
}

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

function idleMcp(): McpPlatform {
  return {
    connect: async (config) => ({ serverId: config.id, state: 'ready' as const, toolCount: 0 }),
    disconnect: async () => undefined,
    listTools: async () => [],
    callTool: async () => ({ structuredContent: {} }),
    close: async () => undefined
  };
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

  it('turns completed local life activity into a bounded Moment candidate', async () => {
    await core.lifeRepo.advance({ activity: '早餐', kind: 'meal', mood: 'happy', startedAt: '2026-08-13T01:00:00.000Z', endsAt: '2026-08-13T01:30:00.000Z' });
    await core.lifeRepo.advance({ activity: '散步', kind: 'out', mood: 'calm', startedAt: '2026-08-13T01:30:00.000Z', endsAt: '2026-08-13T02:00:00.000Z' });

    const candidates = await db.query<{ status: string; source_type: string }>("SELECT status,source_type FROM life_share_candidates");
    expect(candidates).toEqual([{ status: 'pending', source_type: 'event' }]);

    const composed = await core.momentComposer.compose(new Date('2026-08-13T03:00:00.000Z'));
    expect(composed.created).toHaveLength(1);
    expect((await core.moments()).moments[0]?.createdAt).toBe('2026-08-13T01:30:00.000Z');
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

  it('paginates the full local sticker catalogue', async () => {
    for (let index = 0; index < 61; index += 1) {
      const media = await core.mediaRepo.create({
        kind: 'sticker', relPath: `builtin/${index}.gif`, mime: 'image/gif', bytes: 1,
        sha256: `sha-${index}`, origin: 'builtin'
      });
      await core.stickersRepo.create({ mediaId: media.id, name: `表情${index}` });
    }

    const first = await core.stickerSearch({ limit: 60 });
    const second = await core.stickerSearch({ limit: 60, cursor: first.nextCursor });

    expect(first.stickers).toHaveLength(60);
    expect(first.nextCursor).toBe('60');
    expect(second.stickers).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(second.total).toBe(61);
  });

  it('withdraws a fresh user message', async () => {
    const { message } = await core.send({ clientMsgId: 'w-1', content: [{ type: 'text', text: '撤回我' }] });
    const result = await core.withdraw(message.id);
    expect(result.message.meta.withdrawnAt).toBeTruthy();
    expect(result.message.content[0]).toMatchObject({ type: 'text', text: '[消息已撤回]' });
  });

  it('routes admin memory deletion through the durable forget outbox', async () => {
    const localCore = new LocalCore({ db, mcp: idleMcp() });
    const created = await localCore.memoryRepo.upsert({ kind: 'preference', content: '管理员删除的记忆', sourceHash: 'hash-delete' });

    await localCore.adminRequest(`/api/admin/memories/${encodeURIComponent(created.record.id)}`, { method: 'DELETE' });

    await expect(db.query<{ active: number }>('SELECT active FROM memories WHERE id=?', [created.record.id])).resolves.toEqual([{ active: 0 }]);
    await expect(db.query<{ operation: string; status: string; remote_source_id: string }>('SELECT operation,status,remote_source_id FROM memory_sync_outbox WHERE local_memory_id=?', [created.record.id])).resolves.toEqual([{ operation: 'forget', status: 'pending', remote_source_id: created.record.id }]);
  });

  it('creates forget tombstones for every memory when admin clears local memories', async () => {
    const localCore = new LocalCore({ db, mcp: idleMcp() });
    const first = await localCore.memoryRepo.upsert({ kind: 'event', content: '第一条待清理记忆' });
    const second = await localCore.memoryRepo.upsert({ kind: 'event', content: '第二条待清理记忆' });

    await localCore.adminRequest('/api/admin/memories/clear', { method: 'POST' });

    await expect(db.query<{ count: number }>('SELECT COUNT(*) count FROM memory_tombstones')).resolves.toEqual([{ count: 2 }]);
    const expectedIds = [first.record.id, second.record.id].sort();
    await expect(db.query<{ local_memory_id: string }>('SELECT local_memory_id FROM memory_sync_outbox WHERE operation=\'forget\' ORDER BY local_memory_id')).resolves.toEqual(expectedIds.map((local_memory_id) => ({ local_memory_id })));
  });

  it('keeps an admin memory active when the atomic forget transaction fails', async () => {
    const localCore = new LocalCore({ db, mcp: idleMcp() });
    const created = await localCore.memoryRepo.upsert({ kind: 'event', content: '事务失败时仍应保留' });
    const originalTransaction = db.transaction.bind(db);
    db.transaction = async () => { throw new Error('injected transaction failure'); };

    await expect(localCore.adminRequest(`/api/admin/memories/${encodeURIComponent(created.record.id)}`, { method: 'DELETE' })).rejects.toThrow('injected transaction failure');
    db.transaction = originalTransaction;
    await expect(db.query<{ active: number }>('SELECT active FROM memories WHERE id=?', [created.record.id])).resolves.toEqual([{ active: 1 }]);
    await expect(db.query<{ count: number }>('SELECT COUNT(*) count FROM memory_tombstones')).resolves.toEqual([{ count: 0 }]);
  });

  it('keeps every admin memory active when the clear transaction fails', async () => {
    const localCore = new LocalCore({ db, mcp: idleMcp() });
    const first = await localCore.memoryRepo.upsert({ kind: 'event', content: '清空失败一' });
    const second = await localCore.memoryRepo.upsert({ kind: 'event', content: '清空失败二' });
    const originalTransaction = db.transaction.bind(db);
    db.transaction = async () => { throw new Error('injected clear failure'); };

    await expect(localCore.adminRequest('/api/admin/memories/clear', { method: 'POST' })).rejects.toThrow('injected clear failure');
    db.transaction = originalTransaction;
    await expect(db.query<{ id: string; active: number }>('SELECT id,active FROM memories WHERE id IN (?,?) ORDER BY id', [first.record.id, second.record.id])).resolves.toEqual([first.record.id, second.record.id].sort().map((id) => ({ id, active: 1 })));
    await expect(db.query<{ count: number }>('SELECT COUNT(*) count FROM memory_tombstones')).resolves.toEqual([{ count: 0 }]);
  });
});

describe('LocalCore webSearch integration', () => {
  let db: NodeLocalDatabase;
  let secrets: MemorySecrets;

  beforeEach(async () => {
    db = new NodeLocalDatabase();
    await migrateDatabase(db);
    secrets = new MemorySecrets();
  });

  afterEach(async () => await db.close());

  it('round-trips webSearch config through admin models and stores keys in Keychain', async () => {
    const recorded: { requests: Array<{ url: string; secretRef: string | null }> } = { requests: [] };
    const http = searchHttp(recorded);
    const core = new LocalCore({ db, secrets, http });
    await saveWebSearch(core);

    const read = await core.adminRequest<{ models: Record<string, unknown> }>('/api/admin/models');
    const web = read.models.webSearch as Record<string, unknown>;
    expect(web.enabled).toBe(true);
    expect(web.providers).toEqual(['doubao', 'tavily']);
    expect((web.doubao as Record<string, unknown>).apiKeyConfigured).toBe(true);
    expect((web.tavily as Record<string, unknown>).apiKeyConfigured).toBe(true);
    expect((web.doubao as Record<string, unknown>).apiKey).toBeUndefined();
    expect(web.maxResults).toBe(5);

    await expect(secrets.get('provider.webSearch.key')).resolves.toBe('doubao-key');
    await expect(secrets.get('provider.webSearch.fallback.key')).resolves.toBe('tavily-key');

    const runtime = await createWebSearch(http, core.configRepo);
    expect(runtime).not.toBeNull();
    expect(runtime!.order).toEqual(['doubao', 'tavily']);
    expect(runtime!.providers[0]!.configured).toBe(true);
    expect(runtime!.providers[1]!.configured).toBe(true);
  });

  it('runs web search during replies and records citations in message meta', async () => {
    const recorded: { requests: Array<{ url: string; secretRef: string | null }> } = { requests: [] };
    const capturedSystems: string[] = [];
    const core = new LocalCore({ db, secrets, http: searchHttp(recorded), chatProvider: fakeChatProvider(capturedSystems), replyDebounceMs: 0 });
    const completed = waitForEvent(core, 'reply.completed');
    await saveWebSearch(core);
    await core.send({ clientMsgId: 'ws-1', content: [{ type: 'text', text: '帮我搜一下最近有什么新闻' }] });
    await completed;

    expect(capturedSystems.some((system) => system.includes('联网搜索材料'))).toBe(true);
    expect(recorded.requests.some((request) => request.url.includes('doubao.test'))).toBe(true);
    const page = await core.messages({ limit: 10 });
    const assistant = page.messages.find((message) => message.role === 'assistant');
    expect(assistant?.meta.webSearchUsed).toBe(true);
    expect(assistant?.meta.webSearchProvider).toBe('doubao');
    expect(assistant?.meta.webCitations).toEqual([{ title: '新闻一', url: 'https://news.example/1' }]);
  });

  it('does not search or inject citations for non-search messages', async () => {
    const recorded: { requests: Array<{ url: string; secretRef: string | null }> } = { requests: [] };
    const capturedSystems: string[] = [];
    const core = new LocalCore({ db, secrets, http: searchHttp(recorded), chatProvider: fakeChatProvider(capturedSystems), replyDebounceMs: 0 });
    const completed = waitForEvent(core, 'reply.completed');
    await saveWebSearch(core);
    await core.send({ clientMsgId: 'chat-1', content: [{ type: 'text', text: '想你了' }] });
    await completed;

    expect(capturedSystems.some((system) => system.includes('联网搜索材料'))).toBe(false);
    expect(recorded.requests).toHaveLength(0);
  });

  it('degrades honestly when search is offered but not configured', async () => {
    const recorded: { requests: Array<{ url: string; secretRef: string | null }> } = { requests: [] };
    const capturedSystems: string[] = [];
    const core = new LocalCore({ db, secrets, http: searchHttp(recorded), chatProvider: fakeChatProvider(capturedSystems), replyDebounceMs: 0 });
    const completed = waitForEvent(core, 'reply.completed');
    await core.send({ clientMsgId: 'deg-1', content: [{ type: 'text', text: '帮我查一下最新消息' }] });
    await completed;

    expect(capturedSystems.some((system) => system.includes('联网搜索当前不可用'))).toBe(true);
    expect(recorded.requests).toHaveLength(0);
  });
});
