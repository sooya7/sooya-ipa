import { describe, expect, it, vi } from 'vitest';
import { HybridMemoryProvider, MemoryRouter } from './memory-router.js';
import { LocalMemoryProvider, type LocalMemoryStore } from './local-memory-provider.js';
import type { MemoryEntry, MemoryProvider, MemoryRecall, MemoryCommitInput } from './types.js';

function entry(id: string, content: string, score = 0.8): MemoryEntry {
  return {
    id,
    kind: 'preference',
    content,
    normalized: content.replace(/\s+/g, '').toLocaleLowerCase(),
    importance: score,
    confidence: 0.9,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    source: 'local'
  };
}

function provider(overrides: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    wake: async () => null,
    recall: async () => ({ entries: [], strategy: 'none' }),
    commit: async () => ({ state: 'completed', inserted: 0, merged: 0 }),
    search: async () => [],
    list: async () => [],
    update: async () => null,
    forget: async () => false,
    maintain: async () => ({ removed: 0, reembedded: 0 }),
    health: async () => ({ state: 'ready', provider: 'test' }),
    ...overrides
  };
}

describe('LocalMemoryProvider commit boundary', () => {
  it('extracts once and commits through an atomic revision receipt', async () => {
    const committed: Array<{ input: MemoryCommitInput; candidates: unknown[] }> = [];
    const store: LocalMemoryStore = {
      receipt: vi.fn(async () => null),
      commit: vi.fn(async (input, candidates) => {
        committed.push({ input, candidates });
        return { state: 'completed' as const, inserted: 1, merged: 0 };
      }),
      search: async () => [], list: async () => [], update: async () => null,
      forget: async () => false, maintain: async () => ({ removed: 0, reembedded: 0 })
    };
    const extract = vi.fn(async () => [{ kind: 'preference' as const, content: '用户不吃香菜', importance: 0.8, confidence: 0.95 }]);
    const local = new LocalMemoryProvider({ store, extract, currentRevision: async () => 3 });

    const result = await local.commit({ batchId: 'b1', revision: 3, userText: '我不吃香菜', assistantText: '记住啦' });

    expect(result).toEqual({ state: 'completed', inserted: 1, merged: 0 });
    expect(extract).toHaveBeenCalledOnce();
    expect(committed).toHaveLength(1);
    expect(committed[0]!.candidates[0]).toMatchObject({ content: '用户不吃香菜', sourceHash: expect.any(String) });
  });

  it('never extracts or writes a superseded or completed revision', async () => {
    const extract = vi.fn(async () => []);
    const store = {
      receipt: vi.fn(async (_batchId: string, revision: number) => revision === 2 ? { state: 'completed' as const } : null),
      commit: vi.fn(), search: async () => [], list: async () => [], update: async () => null,
      forget: async () => false, maintain: async () => ({ removed: 0, reembedded: 0 })
    } satisfies LocalMemoryStore;
    const local = new LocalMemoryProvider({ store, extract, currentRevision: async () => 4 });

    await expect(local.commit({ batchId: 'b', revision: 2, userText: 'x', assistantText: 'y' })).resolves.toMatchObject({ state: 'completed' });
    await expect(local.commit({ batchId: 'b', revision: 3, userText: 'x', assistantText: 'y' })).resolves.toEqual({ state: 'skipped', inserted: 0, merged: 0, reason: 'superseded_revision' });
    expect(extract).not.toHaveBeenCalled();
    expect(store.commit).not.toHaveBeenCalled();
  });

  it('attaches provider embeddings without making the local commit depend on them', async () => {
    const committed: unknown[] = [];
    const store: LocalMemoryStore = {
      receipt: async () => null,
      commit: async (_input, candidates) => { committed.push(...candidates); return { state: 'completed', inserted: 1, merged: 0 }; },
      search: async () => [], list: async () => [], update: async () => null,
      forget: async () => false, maintain: async () => ({ removed: 0, reembedded: 0 })
    };
    const local = new LocalMemoryProvider({
      store,
      extract: async () => [{ kind: 'event', content: '用户去了海边', importance: 0.6, confidence: 0.8 }],
      currentRevision: async () => 1,
      embeddingProvider: { name: 'embed', configured: true, embed: async () => ({ vectors: [[0.1, 0.2]], model: 'mini', dimensions: 2 }), inspectHealth: async () => ({ capability: 'embedding', configured: true, ok: true, provider: 'mini', checkedAt: '' }) }
    });

    await local.commit({ batchId: 'b-embedding', revision: 1, userText: '海边', assistantText: '记住了' });
    expect(committed[0]).toMatchObject({ embedding: [0.1, 0.2], embeddingModel: 'mini' });
  });
});

describe('MemoryRouter and HybridMemoryProvider', () => {
  it('uses local memory by default', async () => {
    const local = provider({ recall: vi.fn(async () => ({ entries: [entry('l1', '用户喜欢猫')], strategy: 'fts' as const })) });
    const router = new MemoryRouter({ local });

    expect((await router.recall({ query: '猫' })).entries.map((item) => item.id)).toEqual(['l1']);
    expect(router.mode).toBe('local');
  });

  it('merges parallel recall, de-duplicates content, and survives MCP failure', async () => {
    const localRecall = vi.fn(async (): Promise<MemoryRecall> => ({ entries: [entry('l1', '用户喜欢 猫', 0.9)], strategy: 'fts' }));
    const remoteRecall = vi.fn(async (): Promise<MemoryRecall> => ({ entries: [entry('r1', '用户喜欢猫', 0.7), entry('r2', '用户住在上海', 0.8)], strategy: 'remote' }));
    const hybrid = new HybridMemoryProvider({ local: provider({ recall: localRecall }), remote: provider({ recall: remoteRecall }), mirrorWrites: false });

    const result = await hybrid.recall({ query: '用户', limit: 10 });
    expect(result.entries.map((item) => item.id)).toEqual(['l1', 'r2']);
    expect(localRecall).toHaveBeenCalledOnce();
    expect(remoteRecall).toHaveBeenCalledOnce();

    const degraded = new HybridMemoryProvider({ local: provider({ recall: localRecall }), remote: provider({ recall: async () => { throw new Error('MCP down'); } }) });
    await expect(degraded.recall({ query: '猫' })).resolves.toMatchObject({ strategy: 'hybrid-degraded', entries: [{ id: 'l1' }] });
  });

  it('keeps local authoritative and mirrors only when explicitly enabled', async () => {
    const localCommit = vi.fn(async () => ({ state: 'completed' as const, inserted: 1, merged: 0 }));
    const remoteCommit = vi.fn(async () => ({ state: 'completed' as const, inserted: 1, merged: 0 }));
    const input = { batchId: 'b', revision: 1, userText: 'x', assistantText: 'y' };

    await new HybridMemoryProvider({ local: provider({ commit: localCommit }), remote: provider({ commit: remoteCommit }) }).commit(input);
    expect(localCommit).toHaveBeenCalledOnce();
    expect(remoteCommit).not.toHaveBeenCalled();

    await new HybridMemoryProvider({ local: provider({ commit: localCommit }), remote: provider({ commit: remoteCommit }), mirrorWrites: true }).commit(input);
    expect(remoteCommit).toHaveBeenCalledOnce();
  });
});

describe('LocalMemoryProvider retrieval upgrades', () => {
  it('combines local vector retrieval and rerank when both capabilities are available', async () => {
    const store: LocalMemoryStore = {
      receipt: async () => null,
      commit: async () => ({ state: 'completed', inserted: 0, merged: 0 }),
      search: async () => [],
      searchHybrid: async () => [entry('a', '用户喜欢猫', 0.2), entry('b', '用户住在上海', 0.8)],
      list: async () => [], update: async () => null, forget: async () => false,
      maintain: async () => ({ removed: 0, reembedded: 0 })
    };
    const result = await new LocalMemoryProvider({
      store,
      extract: async () => [],
      currentRevision: async () => 1,
      embeddingProvider: { name: 'embed', configured: true, embed: async () => ({ vectors: [[1, 0]], model: 'e', dimensions: 2 }), inspectHealth: async () => ({ capability: 'embedding', configured: true, ok: true, provider: 'e', checkedAt: '' }) },
      rerankProvider: { name: 'rerank', configured: true, rerank: async () => [{ index: 1, score: 0.99 }, { index: 0, score: 0.1 }], inspectHealth: async () => ({ capability: 'rerank', configured: true, ok: true, provider: 'r', checkedAt: '' }) }
    }).recall({ query: '猫', limit: 2 });

    expect(result.strategy).toBe('hybrid');
    expect(result.entries.map((item) => item.id)).toEqual(['b', 'a']);
  });
});
