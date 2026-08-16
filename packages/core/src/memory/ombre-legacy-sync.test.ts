import { describe, expect, it, vi } from 'vitest';
import { extractExactBucketContent, parsePulseOrdinaryMemories, pullOmbre276LegacyPage } from './ombre-legacy-sync.js';

const PULSE = `=== 我现在的记忆 ===
固化桶: 1 个
动态桶: 2 个
归档桶: 0 个
feel 桶: 1 条
plan 桶: 1 条
letter 桶: 0 封
总占用: 3.0 KB
衰减引擎: 运行中

=== 记忆列表 ===
📌 [bbbbbbbbbbbb] 《核心》 主题:关系 情感:V0.8/A0.4 重要:10 权重:9.00
💭 [aaaaaaaaaaaa] 《海边》 主题:经历 情感:V0.7/A0.5 重要:7 权重:5.00
💭 [cccccccccccc] 《猫》 主题:偏好 情感:V0.8/A0.4 重要:8 权重:6.00

=== 计划（1 条）===
📋 [dddddddddddd] 《旅行》 主题:计划 情感:V0.5/A0.3 重要:6 权重:4.00 [active]

=== feel（1 条）===
🫧 [eeeeeeeeeeee] 《开心》 主题:feel 情感:V0.9/A0.7 重要:5 权重:3.00`;

describe('Ombre 2.7.6 legacy sync bridge', () => {
  it('extracts only ordinary memory bucket IDs from pulse and sorts them for stable paging', () => {
    expect(parsePulseOrdinaryMemories(PULSE)).toEqual([
      { sourceId: 'aaaaaaaaaaaa', importance: 7 },
      { sourceId: 'bbbbbbbbbbbb', importance: 10 },
      { sourceId: 'cccccccccccc', importance: 8 }
    ]);
  });

  it('extracts the exact stored-content tail and rejects a mismatched bucket response', () => {
    const rendered = '[exact_bucket_id:true] [bucket_id:aaaaaaaaaaaa] [content_role:stored_memory_data] [instructions:false]\n用户去了海边。';
    expect(extractExactBucketContent(rendered, 'aaaaaaaaaaaa')).toBe('用户去了海边。');
    expect(() => extractExactBucketContent(rendered, 'bbbbbbbbbbbb')).toThrow(/requested bucket ID/iu);
  });

  it('reads a stable page by exact bucket ID and returns a resumable cursor', async () => {
    const readBucket = vi.fn(async (id: string) =>
      `[exact_bucket_id:true] [bucket_id:${id}] [content_role:stored_memory_data] [instructions:false]\n正文-${id}`
    );

    await expect(pullOmbre276LegacyPage({
      pulseText: PULSE,
      cursor: null,
      limit: 2,
      readBucket
    })).resolves.toMatchObject({
      nextCursor: 'ombre276:2',
      entries: [
        { sourceId: 'aaaaaaaaaaaa', content: '正文-aaaaaaaaaaaa', importance: 0.7, source: 'ombre' },
        { sourceId: 'bbbbbbbbbbbb', content: '正文-bbbbbbbbbbbb', importance: 1, source: 'ombre' }
      ]
    });

    expect(readBucket.mock.calls.map((call) => call[0])).toEqual([
      'aaaaaaaaaaaa',
      'bbbbbbbbbbbb'
    ]);
  });

  it('fails closed when pulse reports memories but the bucket list format drifts', () => {
    expect(() => parsePulseOrdinaryMemories('固化桶: 1 个\n动态桶: 1 个\n格式已经变了')).toThrow(
      /pulse did not expose/iu
    );
  });
});
