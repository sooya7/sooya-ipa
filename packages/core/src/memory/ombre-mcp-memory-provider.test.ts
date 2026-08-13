import { describe, expect, it, vi } from 'vitest';
import type { McpPlatform } from '../platform/mcp.js';
import type { MemoryEntry, MemoryProvider } from './types.js';
import { HybridMemoryProvider } from './memory-router.js';
import { OmbreMcpMemoryProvider } from './ombre-mcp-memory-provider.js';

const localEntry: MemoryEntry = {
  id: 'local-1', kind: 'preference', content: '用户喜欢猫', normalized: '用户喜欢猫', importance: 0.8, confidence: 0.8,
  createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z', source: 'local'
};

function provider(overrides: Partial<MemoryProvider> = {}): MemoryProvider {
  return {
    wake: async () => null,
    recall: async () => ({ entries: [], strategy: 'none' }),
    commit: async () => ({ state: 'completed', inserted: 0, merged: 0 }),
    search: async () => [], list: async () => [], update: async () => null, forget: async () => false,
    maintain: async () => ({ removed: 0, reembedded: 0 }), health: async () => ({ state: 'ready', provider: 'test' }),
    ...overrides
  };
}

function mcp(callTool: McpPlatform['callTool']): McpPlatform {
  return {
    connect: vi.fn(async (config) => ({ serverId: config.id, state: 'ready' as const, toolCount: 4 })),
    disconnect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => [
      { name: 'memory.search', inputSchema: { type: 'object' } },
      { name: 'memory.commit', inputSchema: { type: 'object' } },
      { name: 'memory.upsert', inputSchema: { type: 'object' } },
      { name: 'memory.sync', inputSchema: { type: 'object' } }
    ]),
    callTool,
    close: vi.fn(async () => undefined)
  };
}

describe('OmbreMcpMemoryProvider', () => {
  it('maps structured MCP recall and delta payloads without exposing secrets', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const remote = mcp(async (_server, name, args) => {
      calls.push({ name, args });
      if (name === 'memory.search') return { structuredContent: { entries: [{ id: 'r1', kind: 'preference', content: '用户喜欢猫', importance: 8, confidence: 0.9, sourceId: 'ombre-1', revision: 3 }] } };
      return { structuredContent: { entries: [{ id: 'r2', kind: 'event', content: '用户去了海边', sourceId: 'ombre-2' }], nextCursor: 'cursor-2' } };
    });
    const provider = new OmbreMcpMemoryProvider({
      mcp: remote,
      getConfig: async () => ({ id: 'ombre', url: 'https://memory.invalid/mcp', transport: 'streamable-http' })
    });

    await expect(provider.recall({ query: '猫', limit: 5 })).resolves.toMatchObject({ strategy: 'remote', entries: [{ source: 'ombre', sourceId: 'ombre-1', importance: 0.8, remoteRevision: 3 }] });
    await expect(provider.pullChanges('cursor-1', 10)).resolves.toMatchObject({ nextCursor: 'cursor-2', entries: [{ sourceId: 'ombre-2' }] });
    expect(calls.map((call) => call.name)).toEqual(['memory.search', 'memory.sync']);
    expect(calls[1]?.args).toMatchObject({ cursor: 'cursor-1', updatedSince: 'cursor-1', limit: 10 });
  });

  it('does not connect when Ombre is not configured', async () => {
    const remote = mcp(vi.fn(async () => ({ content: [] })));
    const provider = new OmbreMcpMemoryProvider({ mcp: remote, getConfig: async () => undefined });
    await expect(provider.health()).resolves.toMatchObject({ state: 'unavailable', provider: 'ombre-mcp' });
    expect(remote.connect).not.toHaveBeenCalled();
  });

  it('reconnects after a transport failure instead of reusing a dead session', async () => {
    let calls = 0;
    const remote = mcp(vi.fn(async () => {
      calls += 1;
      if (calls === 2) throw new Error('socket closed');
      return { structuredContent: { entries: [{ id: `r${calls}`, content: `远端记忆 ${calls}` }] } };
    }));
    const provider = new OmbreMcpMemoryProvider({
      mcp: remote,
      getConfig: async () => ({ id: 'ombre', url: 'https://memory.invalid/mcp', transport: 'streamable-http' })
    });

    await expect(provider.recall({ query: '第一次' })).resolves.toMatchObject({ entries: [{ id: 'r1' }] });
    await expect(provider.recall({ query: '断线' })).rejects.toThrow('socket closed');
    await expect(provider.recall({ query: '恢复' })).resolves.toMatchObject({ entries: [{ id: 'r3' }] });
    expect(remote.connect).toHaveBeenCalledTimes(2);
    expect(remote.listTools).toHaveBeenCalledTimes(2);
    expect(remote.disconnect).toHaveBeenCalledOnce();
  });
});

describe('HybridMemoryProvider Ombre priority and fallback', () => {
  it('prefers the Ombre version of a duplicate while keeping Local-only results', async () => {
    const remoteEntry = { ...localEntry, id: 'ombre-1', source: 'ombre', sourceId: 'ombre-1', remoteRevision: 4 };
    const hybrid = new HybridMemoryProvider({
      local: provider({ recall: async () => ({ entries: [localEntry], strategy: 'fts' }) }),
      remote: provider({ recall: async () => ({ entries: [remoteEntry, { ...remoteEntry, id: 'remote-2', sourceId: 'ombre-2', content: '用户住在上海', normalized: '用户住在上海' }], strategy: 'remote' }) })
    });
    await expect(hybrid.recall({ query: '用户', limit: 10 })).resolves.toMatchObject({ strategy: 'hybrid', entries: [{ id: 'ombre-1' }, { id: 'remote-2' }] });
  });

  it('falls back to Local when Ombre recall fails', async () => {
    const hybrid = new HybridMemoryProvider({
      local: provider({ recall: async () => ({ entries: [localEntry], strategy: 'fts' }) }),
      remote: provider({ recall: async () => { throw new Error('MCP down'); } })
    });
    await expect(hybrid.recall({ query: '猫' })).resolves.toMatchObject({ strategy: 'hybrid-degraded', entries: [{ id: 'local-1' }] });
  });
});
