import { describe, expect, it, vi } from 'vitest';
import type { McpPlatform, McpServerConfig, McpTool } from '../platform/mcp.js';
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

  describe('ensureReady singleflight: concurrent callers share one connect+discovery', () => {
    const CONFIG: McpServerConfig = { id: 'ombre', url: 'https://memory.invalid/mcp', transport: 'streamable-http' };
    const TOOLS: McpTool[] = [
      { name: 'memory.search', inputSchema: { type: 'object' } },
      { name: 'memory.commit', inputSchema: { type: 'object' } },
      { name: 'memory.upsert', inputSchema: { type: 'object' } },
      { name: 'memory.sync', inputSchema: { type: 'object' } }
    ];
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    function delayedMcp(options: { connectError?: Error; connectDelayMs?: number; listDelayMs?: number } = {}) {
      let connectAttempts = 0;
      const connect = vi.fn(async (config: McpServerConfig) => {
        connectAttempts += 1;
        if (options.connectError && connectAttempts === 1) throw options.connectError;
        if (options.connectDelayMs) await sleep(options.connectDelayMs);
        return { serverId: config.id, state: 'ready' as const, toolCount: TOOLS.length };
      });
      const listTools = vi.fn(async () => {
        if (options.listDelayMs) await sleep(options.listDelayMs);
        return TOOLS;
      });
      const callTool = vi.fn(async (_serverId: string, name: string) => name === 'memory.search'
        ? { structuredContent: { entries: [{ id: 'r1', kind: 'event', content: '并发共享连接' }] } }
        : { structuredContent: { entries: [], nextCursor: null } });
      const disconnect = vi.fn(async () => undefined);
      const mcp: McpPlatform = { connect, disconnect, listTools, callTool, close: vi.fn(async () => undefined) };
      return { mcp, connect, disconnect, listTools, callTool };
    }

    it('runs connect+listTools exactly once for concurrent health, pullChanges and recall', async () => {
      const { mcp, connect, listTools } = delayedMcp({ connectDelayMs: 30, listDelayMs: 20 });
      const provider = new OmbreMcpMemoryProvider({ mcp, getConfig: async () => CONFIG });

      const [health, pulled, recalled] = await Promise.all([
        provider.health(),
        provider.pullChanges('cursor-1', 10),
        provider.recall({ query: '猫', limit: 5 })
      ]);

      expect(connect).toHaveBeenCalledTimes(1);
      expect(listTools).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledWith(expect.objectContaining({ id: 'ombre', url: CONFIG.url, transport: CONFIG.transport }));
      expect(health).toMatchObject({ state: 'ready', detail: '4 tools' });
      expect(pulled).toMatchObject({ entries: [], nextCursor: null });
      expect(recalled).toMatchObject({ strategy: 'remote', entries: [{ id: 'r1' }] });
    });

    it('reuses the established session for later operations without reconnecting', async () => {
      const { mcp, connect, listTools } = delayedMcp();
      const provider = new OmbreMcpMemoryProvider({ mcp, getConfig: async () => CONFIG });

      await Promise.all([provider.health(), provider.recall({ query: '第一次' })]);
      await provider.health();
      await provider.pullChanges('c2', 5);
      await provider.recall({ query: '第二次' });

      expect(connect).toHaveBeenCalledTimes(1);
      expect(listTools).toHaveBeenCalledTimes(1);
    });

    it('clears the in-flight lock on failure and retries on the next call', async () => {
      const { mcp, connect, disconnect } = delayedMcp({ connectError: new Error('connect refused'), connectDelayMs: 10 });
      const provider = new OmbreMcpMemoryProvider({ mcp, getConfig: async () => CONFIG });

      const first = await Promise.allSettled([provider.health(), provider.pullChanges('c1', 5)]);
      expect(first[0]).toMatchObject({ status: 'fulfilled', value: { state: 'unavailable', detail: 'connect refused' } });
      expect(first[1].status).toBe('rejected');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(disconnect).not.toHaveBeenCalled();

      // Lock cleared: the next call starts a fresh connect and succeeds.
      await expect(provider.health()).resolves.toMatchObject({ state: 'ready' });
      expect(connect).toHaveBeenCalledTimes(2);
      expect(disconnect).not.toHaveBeenCalled();
    });

    it('reconnects with one shared pass when the config changes, discarding the old session', async () => {
      const { mcp, connect, disconnect } = delayedMcp({ connectDelayMs: 10 });
      let url = 'https://a.invalid/mcp';
      const provider = new OmbreMcpMemoryProvider({
        mcp,
        getConfig: async () => ({ ...CONFIG, url })
      });

      await expect(provider.health()).resolves.toMatchObject({ state: 'ready' });
      url = 'https://b.invalid/mcp';
      const settled = await Promise.allSettled([provider.health(), provider.pullChanges('c1', 5)]);
      expect(settled[0]).toMatchObject({ status: 'fulfilled', value: { state: 'ready' } });
      expect(settled[1].status).toBe('fulfilled');

      expect(connect).toHaveBeenCalledTimes(2);
      expect(disconnect).toHaveBeenCalledTimes(1); // old session discarded once
    });

    it('invalidates the shared lock after a transport failure so the next burst reconnects once', async () => {
      let callCount = 0;
      const { mcp, connect, listTools, disconnect } = delayedMcp();
      mcp.callTool = vi.fn(async () => {
        callCount += 1;
        if (callCount === 2) throw new Error('session closed');
        return { structuredContent: { entries: [], nextCursor: null } };
      });
      const provider = new OmbreMcpMemoryProvider({ mcp, getConfig: async () => CONFIG });

      await provider.pullChanges('c0', 5);
      await expect(provider.pullChanges('c1', 5)).rejects.toThrow('session closed');
      expect(connect).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledTimes(1); // invalidate disconnected the dead session

      // The next concurrent burst shares exactly one reconnect.
      await Promise.all([provider.health(), provider.pullChanges('c2', 5), provider.recall({ query: '恢复' })]);
      expect(connect).toHaveBeenCalledTimes(2);
      expect(listTools).toHaveBeenCalledTimes(2);
      expect(disconnect).toHaveBeenCalledTimes(1);
    });

    it('lets an aborted caller leave without joining the shared connect', async () => {
      const { mcp, connect } = delayedMcp();
      const provider = new OmbreMcpMemoryProvider({ mcp, getConfig: async () => CONFIG });
      const controller = new AbortController();
      controller.abort();

      await expect(provider.recall({ query: 'x', signal: controller.signal })).rejects.toThrow(/aborted/);
      expect(connect).not.toHaveBeenCalled();
    });
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
