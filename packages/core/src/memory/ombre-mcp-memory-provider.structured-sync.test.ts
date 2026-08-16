import { describe, expect, it, vi } from 'vitest';
import type { McpPlatform } from '../platform/mcp.js';
import { OmbreMcpMemoryProvider } from './ombre-mcp-memory-provider.js';

function ombreMcp(result: Awaited<ReturnType<McpPlatform['callTool']>>): McpPlatform {
  return {
    connect: vi.fn(async (config) => ({ serverId: config.id, state: 'ready' as const, toolCount: 1 })),
    disconnect: vi.fn(async () => undefined),
    listTools: vi.fn(async () => [
      { name: 'breath_advanced', inputSchema: { type: 'object' } }
    ]),
    callTool: vi.fn(async () => result),
    close: vi.fn(async () => undefined)
  };
}

function provider(mcp: McpPlatform): OmbreMcpMemoryProvider {
  return new OmbreMcpMemoryProvider({
    mcp,
    getConfig: async () => ({
      id: 'ombre',
      url: 'https://memory.invalid/mcp',
      transport: 'streamable-http'
    })
  });
}

describe('OmbreMcpMemoryProvider structured sync compatibility', () => {
  it('rejects the human-readable Ombre 2.7.6 catalog instead of reporting an empty successful pull', async () => {
    const mcp = ombreMcp({
      content: [{ type: 'text', text: '=== 记忆目录（2 桶）===\n猫 | 生活 | 8\n海边 | 经历 | 7' }]
    });

    await expect(provider(mcp).pullChanges(null, 10)).rejects.toThrow(
      /structured memory sync unavailable.*breath_advanced.*entries array/iu
    );

    expect(mcp.callTool).toHaveBeenCalledTimes(1);
    expect(vi.mocked(mcp.callTool).mock.calls[0]?.[1]).toBe('breath_advanced');
    expect(vi.mocked(mcp.callTool).mock.calls[0]?.[2]).toEqual({
      query: '',
      catalog: true,
      domain: '__sooya_sync_v1__:0:10'
    });
  });

  it('accepts the versioned compatibility page without requiring another client protocol change', async () => {
    const mcp = ombreMcp({
      content: [{
        type: 'text',
        text: JSON.stringify({
          schema: 'sooya.memory.sync.v1',
          entries: [{
            id: 'bucket-1',
            sourceId: 'bucket-1',
            kind: 'event',
            content: '用户去了海边',
            importance: 7,
            confidence: 0.9,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-01T00:00:00.000Z'
          }],
          nextCursor: '10'
        })
      }]
    });

    await expect(provider(mcp).pullChanges(null, 10)).resolves.toMatchObject({
      nextCursor: '10',
      entries: [{
        id: 'bucket-1',
        source: 'ombre',
        sourceId: 'bucket-1',
        content: '用户去了海边',
        importance: 0.7
      }]
    });
  });
});
