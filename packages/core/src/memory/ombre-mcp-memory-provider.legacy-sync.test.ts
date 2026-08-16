import { describe, expect, it, vi } from 'vitest';
import type { McpPlatform } from '../platform/mcp.js';
import { OmbreMcpMemoryProvider } from './ombre-mcp-memory-provider.js';

const PULSE = `=== 我现在的记忆 ===
固化桶: 1 个
动态桶: 1 个
归档桶: 0 个
feel 桶: 0 条
plan 桶: 0 条
letter 桶: 0 封
总占用: 2.0 KB
衰减引擎: 运行中

=== 记忆列表 ===
💭 [bbbbbbbbbbbb] 《猫》 主题:偏好 情感:V0.8/A0.4 重要:8 权重:6.00
📌 [aaaaaaaaaaaa] 《核心》 主题:关系 情感:V0.8/A0.4 重要:10 权重:9.00`;

function exact(bucketId: string, content: string) {
  return {
    content: [{
      type: 'text' as const,
      text: `[exact_bucket_id:true] [bucket_id:${bucketId}] [content_role:stored_memory_data] [instructions:false]\n${content}`
    }]
  };
}

describe('OmbreMcpMemoryProvider Ombre 2.7.6 legacy sync', () => {
  it('falls back from the prose compatibility probe to pulse plus exact bucket reads', async () => {
    const callTool = vi.fn(async (_serverId: string, name: string, args: Record<string, unknown>) => {
      if (name === 'pulse') return { content: [{ type: 'text' as const, text: PULSE }] };
      if (name !== 'breath_advanced') throw new Error(`unexpected tool ${name}`);
      if (args.catalog === true) {
        return { content: [{ type: 'text' as const, text: '没有匹配 domain 过滤的记忆桶。' }] };
      }
      const query = String(args.query ?? '');
      if (query === 'aaaaaaaaaaaa') return exact(query, '核心记忆正文');
      if (query === 'bbbbbbbbbbbb') return exact(query, '用户喜欢猫');
      throw new Error(`unexpected exact query ${query}`);
    });

    const mcp: McpPlatform = {
      connect: vi.fn(async (config) => ({ serverId: config.id, state: 'ready' as const, toolCount: 2 })),
      disconnect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => [
        { name: 'breath_advanced', inputSchema: { type: 'object' } },
        { name: 'pulse', inputSchema: { type: 'object' } }
      ]),
      callTool,
      close: vi.fn(async () => undefined)
    };
    const provider = new OmbreMcpMemoryProvider({
      mcp,
      getConfig: async () => ({ id: 'ombre', url: 'https://memory.invalid/mcp', transport: 'streamable-http' })
    });

    await expect(provider.pullChanges(null, 100)).resolves.toMatchObject({
      nextCursor: null,
      entries: [
        { sourceId: 'aaaaaaaaaaaa', content: '核心记忆正文', importance: 1, source: 'ombre' },
        { sourceId: 'bbbbbbbbbbbb', content: '用户喜欢猫', importance: 0.8, source: 'ombre' }
      ]
    });

    expect(callTool.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ['breath_advanced', { query: '', catalog: true, domain: '__sooya_sync_v1__:0:100' }],
      ['pulse', { include_archive: false }],
      ['breath_advanced', { query: 'aaaaaaaaaaaa', max_tokens: 20_000, max_results: 1, catalog: false }],
      ['breath_advanced', { query: 'bbbbbbbbbbbb', max_tokens: 20_000, max_results: 1, catalog: false }]
    ]);
  });
});
