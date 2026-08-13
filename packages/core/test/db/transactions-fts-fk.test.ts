import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/db/migrations.js';
import { JobRepo, LifeRepo, MediaRepo, MemoryRepo, MessageRepo, MetricsRepo, StickerRepo } from '../../src/db/index.js';
import { NodeLocalDatabase } from './node-local-database.js';

describe('native batch transactions, FTS and foreign keys', () => {
  let db: NodeLocalDatabase;

  beforeEach(async () => {
    db = new NodeLocalDatabase();
    await migrateDatabase(db);
  });

  afterEach(async () => db.close());

  it('creates a message and all parts with one native transaction call', async () => {
    const repo = new MessageRepo(db);
    const before = db.transactionCalls;

    const result = await repo.create({ role: 'user', parts: [{ type: 'text', text: '一' }, { type: 'text', text: '二' }] });

    expect(result.created).toBe(true);
    expect(db.transactionCalls - before).toBe(1);
    const operations = db.transactionHistory.at(-1)!;
    expect(operations.filter((operation) => /INSERT INTO message_parts/u.test(operation.sql))).toHaveLength(2);
  });

  it('rolls the whole message batch back on a foreign-key failure', async () => {
    const repo = new MessageRepo(db);

    await expect(repo.create({ role: 'user', parts: [{ type: 'image', mediaId: 'missing' }] })).rejects.toThrow();

    await expect(repo.count()).resolves.toBe(0);
    const counters = await db.query<{ value: number }>("SELECT value FROM counters WHERE name = 'message_seq'");
    expect(counters[0]!.value).toBe(0);
  });

  it('uses one batch for other compound writes instead of per-SQL bridge transactions', async () => {
    const life = new LifeRepo(db);
    await life.advance({ activity: '睡觉', kind: 'sleep', mood: 'calm', startedAt: '2026-08-12T16:00:00.000Z', endsAt: '2026-08-13T00:00:00.000Z' });
    const beforeLife = db.transactionCalls;
    await life.advance({ activity: '起床', kind: 'routine', mood: 'calm', startedAt: '2026-08-13T00:00:00.000Z', endsAt: '2026-08-13T01:00:00.000Z' });
    expect(db.transactionCalls - beforeLife).toBe(1);

    const metrics = new MetricsRepo(db);
    const beforeMetrics = db.transactionCalls;
    await metrics.record('life', 'transitions', 1, '2026-08-13');
    expect(db.transactionCalls - beforeMetrics).toBe(1);

    const jobs = new JobRepo(db);
    await jobs.enqueue('reply', { batchId: 'b1' });
    const beforeClaim = db.transactionCalls;
    await expect(jobs.claimNext()).resolves.toMatchObject({ status: 'running', attempts: 1 });
    expect(db.transactionCalls - beforeClaim).toBe(1);
  });

  it('atomically commits local memory candidates and its durable receipt', async () => {
    const memories = new MemoryRepo(db);
    const before = db.transactionCalls;

    const result = await memories.commit(
      { batchId: 'batch-memory', revision: 2, userText: '我喜欢猫', assistantText: '记住了' },
      [{ kind: 'preference', content: '用户喜欢猫', importance: 0.8, confidence: 0.9, sourceHash: 'hash-1' }]
    );

    expect(result).toEqual({ state: 'completed', inserted: 1, merged: 0 });
    expect(db.transactionCalls - before).toBe(1);
    await expect(memories.receipt('batch-memory', 2)).resolves.toMatchObject({ state: 'completed', inserted: 1 });
  });

  it('keeps message, memory and sticker FTS indexes live', async () => {
    const messages = new MessageRepo(db);
    await messages.create({ role: 'user', parts: [{ type: 'text', text: '今天想吃草莓蛋糕' }] });
    await expect(messages.search('草莓蛋糕')).resolves.toMatchObject({ hits: [{ message: { role: 'user' } }] });

    const memories = new MemoryRepo(db);
    await memories.upsert({ kind: 'preference', content: '用户喜欢布丁猫' });
    await expect(memories.searchFts('布丁猫')).resolves.toMatchObject([{ content: '用户喜欢布丁猫' }]);

    const media = new MediaRepo(db);
    const row = await media.create({ kind: 'sticker', relPath: 'stickers/happy.webp', mime: 'image/webp', bytes: 1, sha256: 'happy', origin: 'upload' });
    const stickers = new StickerRepo(db);
    await stickers.create({ mediaId: row.id, name: '大笑', description: '开心得哈哈大笑' });
    await expect(stickers.searchFts('哈哈大笑')).resolves.toMatchObject([{ name: '大笑' }]);
  });

  it('enforces cascading and restrictive foreign keys', async () => {
    const media = new MediaRepo(db);
    const stickers = new StickerRepo(db);
    const row = await media.create({ kind: 'sticker', relPath: 'stickers/a.webp', mime: 'image/webp', bytes: 1, sha256: 'a', origin: 'upload' });
    await stickers.create({ mediaId: row.id, name: 'A' });

    await expect(media.delete(row.id)).resolves.toBe(true);
    await expect(stickers.count(false)).resolves.toBe(0);

    const integrity = await db.integrityCheck();
    expect(integrity).toMatchObject({ ok: true, foreignKeys: [] });
  });
});

