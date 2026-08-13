import { afterEach, describe, expect, it } from 'vitest';
import type { McpPlatform } from '../platform/mcp.js';
import { migrateDatabase } from '../db/migrations.js';
import { MemoryRepo } from '../db/memory.repo.js';
import { MemorySyncRepository } from '../db/memory-sync.repo.js';
import { NodeLocalDatabase } from '../../test/db/node-local-database.js';
import { MemorySyncService } from './memory-sync-service.js';
import { OmbreMcpMemoryProvider } from './ombre-mcp-memory-provider.js';

const openDatabases: NodeLocalDatabase[] = [];

afterEach(async () => {
  while (openDatabases.length) await openDatabases.pop()!.close();
});

function fakeMcp(): McpPlatform {
  return {
    connect: async (config) => ({ serverId: config.id, state: 'ready' as const, toolCount: 3 }),
    disconnect: async () => undefined,
    listTools: async () => [
      { name: 'memory.sync', inputSchema: { type: 'object' } },
      { name: 'memory.upsert', inputSchema: { type: 'object' } },
      { name: 'memory.forget', inputSchema: { type: 'object' } }
    ],
    callTool: async (_serverId, name, args) => {
      if (name === 'memory.sync') return { structuredContent: { entries: [{ id: 'remote-1', sourceId: 'remote-1', kind: 'event', content: '远端同步记忆', importance: 0.7, confidence: 0.8, revision: 4 }], nextCursor: 'remote-cursor-1' } };
      if (name === 'memory.upsert') return { structuredContent: { entries: [{ ...args, source: 'ombre', id: typeof args.sourceId === 'string' ? args.sourceId : 'remote-created', sourceId: typeof args.sourceId === 'string' ? args.sourceId : 'remote-created' }] } };
      return { structuredContent: { deleted: true } };
    },
    close: async () => undefined
  };
}

describe('MemorySyncService', () => {
  it('pulls a remote delta, mirrors it locally, and drains the durable push outbox', async () => {
    const db = new NodeLocalDatabase();
    openDatabases.push(db);
    await migrateDatabase(db);
    const now = () => new Date('2026-08-14T00:00:00.000Z');
    const local = new MemoryRepo(db, now);
    const created = await local.upsert({ kind: 'preference', content: '本地待同步记忆', importance: 0.8, confidence: 0.9 });
    const remote = new OmbreMcpMemoryProvider({ mcp: fakeMcp(), getConfig: async () => ({ id: 'ombre', url: 'https://memory.invalid/mcp', transport: 'streamable-http' }) });
    const sync = new MemorySyncRepository(db, now);
    const service = new MemorySyncService({ local, sync, remote, now });

    await expect(service.syncOnce()).resolves.toMatchObject({ state: 'ready', pulled: 1, pushed: 1, pending: 0 });
    await expect(sync.getCursor('ombre')).resolves.toBe('remote-cursor-1');
    await expect(local.findBySourceId('remote-1')).resolves.toMatchObject({ content: '远端同步记忆', source: 'ombre', source_id: 'remote-1' });
    await expect(sync.state(created.record.id)).resolves.toMatchObject({ sync_state: 'synced' });
    await expect(sync.pending()).resolves.toHaveLength(0);
  });

  it('keeps the outbox pending while Ombre is unavailable', async () => {
    const db = new NodeLocalDatabase();
    openDatabases.push(db);
    await migrateDatabase(db);
    const now = () => new Date('2026-08-14T00:00:00.000Z');
    const local = new MemoryRepo(db, now);
    const created = await local.upsert({ kind: 'preference', content: '离线仍要保留', importance: 0.8, confidence: 0.9 });
    const remote = new OmbreMcpMemoryProvider({ mcp: fakeMcp(), getConfig: async () => undefined });
    const sync = new MemorySyncRepository(db, now);
    const service = new MemorySyncService({ local, sync, remote, now });

    await expect(service.syncOnce()).resolves.toMatchObject({ state: 'unavailable', pushed: 0, pulled: 0 });
    await expect(sync.pending()).resolves.toHaveLength(1);
    await expect(sync.state(created.record.id)).resolves.toMatchObject({ sync_state: 'pending_push' });
  });

  it('does not rewrite an unchanged catalog entry on every fallback pull', async () => {
    let catalogCalls = 0;
    const mcp: McpPlatform = {
      connect: async (config) => ({ serverId: config.id, state: 'ready' as const, toolCount: 1 }),
      disconnect: async () => undefined,
      listTools: async () => [{ name: 'memory.list', inputSchema: { type: 'object' } }],
      callTool: async (_serverId, name) => {
        expect(name).toBe('memory.list');
        catalogCalls += 1;
        return {
          structuredContent: {
            entries: [{ id: 'catalog-1', sourceId: 'catalog-1', kind: 'event', content: '目录中的稳定记忆', normalized: '目录中的稳定记忆', importance: 0.7, confidence: 0.8, updatedAt: '2026-08-13T00:00:00.000Z' }]
          }
        };
      },
      close: async () => undefined
    };
    const db = new NodeLocalDatabase();
    openDatabases.push(db);
    await migrateDatabase(db);
    const now = () => new Date('2026-08-14T00:00:00.000Z');
    const local = new MemoryRepo(db, now);
    const remote = new OmbreMcpMemoryProvider({ mcp, getConfig: async () => ({ id: 'ombre', url: 'https://memory.invalid/mcp', transport: 'streamable-http' }) });
    const sync = new MemorySyncRepository(db, now);
    const service = new MemorySyncService({ local, sync, remote, now });

    await expect(service.syncOnce()).resolves.toMatchObject({ pulled: 1 });
    await expect(service.syncOnce()).resolves.toMatchObject({ pulled: 0 });
    expect(catalogCalls).toBe(2);
    await expect(local.findBySourceId('catalog-1')).resolves.toMatchObject({ content: '目录中的稳定记忆' });
  });
});
