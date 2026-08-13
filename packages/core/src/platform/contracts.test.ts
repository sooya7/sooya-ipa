import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { BinaryData } from '../providers/types.js';
import type {
  DatabasePlatform,
  HttpPlatform,
  LifecyclePlatform,
  LoggerPlatform,
  McpConnectionState,
  McpPlatform,
  McpServerConfig,
  MediaPlatform,
  SecretsPlatform,
  SooyaPlatform
} from './index.js';

describe('platform contracts', () => {
  it('compose one platform without Node-specific values', async () => {
    const database: DatabasePlatform = {
      execute: vi.fn(async () => ({ changes: 0 })),
      query: vi.fn(async () => []),
      queryOne: vi.fn(async () => undefined),
      transaction: async (operation) => operation(database),
      close: vi.fn(async () => undefined)
    };
    const secrets: SecretsPlatform = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined)
    };
    const http: HttpPlatform = {
      request: vi.fn(async () => ({ status: 200, headers: {}, body: new Uint8Array() })),
      stream: vi.fn(async (_request, onChunk) => {
        onChunk(new Uint8Array([1]));
        return { status: 200, headers: {} };
      })
    };
    const media: MediaPlatform = {
      save: vi.fn(async (input) => ({ id: 'm1', kind: input.kind, mime: input.mime ?? 'application/octet-stream', bytes: input.data.byteLength })),
      read: vi.fn(async () => null),
      remove: vi.fn(async () => false)
    };
    const mcp: McpPlatform = {
      connect: vi.fn(async (config: McpServerConfig): Promise<McpConnectionState> => ({
        serverId: config.id,
        state: 'ready',
        toolCount: 0
      })),
      disconnect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => ({ content: [] })),
      close: vi.fn(async () => undefined)
    };
    const logger: LoggerPlatform = {
      trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      child: vi.fn(() => logger)
    };
    const lifecycle: LifecyclePlatform = {
      currentState: () => 'active',
      onStateChange: () => () => undefined,
      onShutdown: () => () => undefined
    };
    const platform: SooyaPlatform = { database, secrets, http, media, mcp, logger, lifecycle };
    await platform.database.execute('SELECT 1');
    expect(platform.lifecycle.currentState()).toBe('active');
    expect(platform.http.request).toHaveBeenCalledTimes(0);
  });

  it('keeps every platform binary seam within the shared binary type', () => {
    expectTypeOf<Parameters<HttpPlatform['stream']>[1]>().parameter(0).toEqualTypeOf<Uint8Array>();
    expectTypeOf<Parameters<MediaPlatform['save']>[0]['data']>().toEqualTypeOf<BinaryData>();
    expectTypeOf<NonNullable<Awaited<ReturnType<MediaPlatform['read']>>>['data']>().toEqualTypeOf<Uint8Array>();
  });
});
