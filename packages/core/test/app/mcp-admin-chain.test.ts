import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalCore } from '../../src/app/local-core.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import type { McpConnectionState, McpPlatform, McpServerConfig, McpTool } from '../../src/platform/mcp.js';
import type { SecretsPlatform } from '../../src/platform/secrets.js';
import { NodeLocalDatabase } from '../db/node-local-database.js';

/** The 14 Ombre Brain tools (v2.7.6) as discovered through tools/list. */
const OMBRE_TOOLS: McpTool[] = [
  'hold', 'breath', 'breath_search', 'breath_catalog', 'breath_advanced', 'breath_release',
  'memory.search', 'memory.commit', 'memory.sync', 'memory.list', 'memory.upsert', 'memory.update',
  'memory.forget', 'memory.maintain'
].map((name) => ({ name, description: `Ombre tool ${name}`, inputSchema: { type: 'object', properties: {} } }));

class MemorySecrets implements SecretsPlatform {
  private readonly values = new Map<string, string>();
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async remove(key: string): Promise<void> { this.values.delete(key); }
}

/** McpPlatform stand-in mirroring the CapacitorMcp bridge contract, with
 * call recording so tests can assert the exact native chain order. */
class RecordingMcp implements McpPlatform {
  connects: Array<{ id: string; url: string }> = [];
  listToolCalls = 0;
  disconnects: string[] = [];
  tools: McpTool[] = OMBRE_TOOLS;
  connectDelayMs = 0;
  listDelayMs = 0;
  connectState: McpConnectionState['state'] = 'ready';

  async connect(config: McpServerConfig): Promise<McpConnectionState> {
    this.connects.push({ id: config.id, url: config.url });
    if (this.connectDelayMs) await new Promise((resolve) => setTimeout(resolve, this.connectDelayMs));
    return { serverId: config.id, state: this.connectState, toolCount: this.tools.length, detail: 'streamable-http' };
  }
  async disconnect(serverId: string): Promise<void> { this.disconnects.push(serverId); }
  async listTools(serverId: string, signal?: AbortSignal): Promise<McpTool[]> {
    this.listToolCalls += 1;
    if (this.listDelayMs) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, this.listDelayMs);
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); }, { once: true });
    });
    return this.tools;
  }
  async callTool(): Promise<never> { throw new Error('not used'); }
  async close(): Promise<void> { /* no-op */ }
}

describe('Native MCP tools/list chain: McpPlatform -> admin refresh persistence', () => {
  let db: NodeLocalDatabase;
  let secrets: MemorySecrets;
  let mcp: RecordingMcp;
  let core: LocalCore;

  beforeEach(async () => {
    db = new NodeLocalDatabase();
    await migrateDatabase(db);
    secrets = new MemorySecrets();
    mcp = new RecordingMcp();
    core = new LocalCore({ db, secrets, mcp });
  });

  afterEach(async () => await db.close());

  async function saveOmbreServer(): Promise<void> {
    await core.adminRequest('/api/admin/mcp/servers', {
      method: 'PUT',
      body: { id: 'ombre', name: 'ombre', url: 'https://echo.sooya.icu/mcp', transport: 'streamable-http', token: 'secret-token', enabled: true, required: false }
    });
  }

  it('connects, lists 14 tools, registers them and persists counts end to end', async () => {
    await saveOmbreServer();

    const refreshed = await core.adminRequest<{ ok: boolean; server: Record<string, unknown> }>('/api/admin/mcp/ombre/refresh-tools', { method: 'POST' });
    expect(refreshed.ok).toBe(true);
    expect(refreshed.server.state).toBe('ready');
    expect(refreshed.server.toolCount).toBe(14);
    expect(refreshed.server.lastRefreshAt).toBeTruthy();
    // Exactly one native session: connect then listTools, in that order.
    expect(mcp.connects).toHaveLength(1);
    expect(mcp.connects[0]!.id).toBe('ombre');
    expect(mcp.connects[0]!.url).toBe('https://echo.sooya.icu/mcp');
    expect(mcp.listToolCalls).toBe(1);

    const overview = await core.adminRequest<{ servers: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> }>('/api/admin/mcp/servers');
    expect(overview.servers[0]!.toolCount).toBe(14);
    expect(overview.tools).toHaveLength(14);
    expect(overview.tools.map((tool) => tool.name)).toContain('mcp.ombre.memory_search');
    expect(overview.tools.map((tool) => tool.modelName)).toContain('mcp_ombre_memory_search');

    // A second refresh reconnects and persists the same counts (idempotent).
    // The overview GET above may additionally drive the Ombre memory
    // adapter's own probe connect, so count deltas around the refresh only.
    const connectsBeforeSecond = mcp.connects.length;
    const again = await core.adminRequest<{ ok: boolean; server: Record<string, unknown> }>('/api/admin/mcp/ombre/refresh-tools', { method: 'POST' });
    expect(again.ok).toBe(true);
    expect(again.server.toolCount).toBe(14);
    expect(mcp.connects.length).toBe(connectsBeforeSecond + 1);
  });

  it('reports "no tools discovered" instead of marking an empty discovery ready', async () => {
    await saveOmbreServer();
    mcp.tools = [];

    await expect(core.adminRequest('/api/admin/mcp/ombre/refresh-tools', { method: 'POST' })).rejects.toThrow(/no tools discovered/);
    expect(mcp.listToolCalls).toBe(1);

    // The persisted state carries the concrete diagnostic, not a vague "degraded".
    const rows = await db.query<{ state: string; last_error: string | null }>('SELECT state,last_error FROM mcp_servers WHERE id=?', ['ombre']);
    expect(rows[0]!.state).toBe('degraded');
    expect(rows[0]!.last_error).toContain('no tools discovered');
    expect(rows[0]!.last_error).toContain('echo.sooya.icu/mcp');

    // The error is recorded for diagnostics.
    const errors = await db.query<{ scope: string; message: string }>("SELECT scope,message FROM error_log WHERE scope='mcp.ombre'");
    expect(errors[0]!.message).toContain('no tools discovered');

    const overview = await core.adminRequest<{ servers: Array<Record<string, unknown>>; tools: Array<Record<string, unknown>> }>('/api/admin/mcp/servers');
    expect(overview.servers[0]!.toolCount).toBe(0);
    expect(overview.tools).toHaveLength(0);
    expect(overview.servers[0]!.lastError).toContain('no tools discovered');
  });

  it('marks an empty discovery with a fresh error and keeps a later healthy refresh working', async () => {
    await saveOmbreServer();
    mcp.tools = [];
    await expect(core.adminRequest('/api/admin/mcp/ombre/refresh-tools', { method: 'POST' })).rejects.toThrow(/no tools discovered/);

    // Server recovers: next refresh returns to ready with full counts.
    mcp.tools = OMBRE_TOOLS;
    const refreshed = await core.adminRequest<{ ok: boolean; server: Record<string, unknown> }>('/api/admin/mcp/ombre/refresh-tools', { method: 'POST' });
    expect(refreshed.ok).toBe(true);
    expect(refreshed.server.state).toBe('ready');
    expect(refreshed.server.toolCount).toBe(14);
    expect(refreshed.server.lastError).toBeNull();
  });
});

describe('Ombre adapter health: ready+0 tools must be a diagnosable degraded state', () => {
  let db: NodeLocalDatabase;
  let secrets: MemorySecrets;
  let mcp: RecordingMcp;
  let core: LocalCore;

  beforeEach(async () => {
    db = new NodeLocalDatabase();
    await migrateDatabase(db);
    secrets = new MemorySecrets();
    mcp = new RecordingMcp();
    core = new LocalCore({ db, secrets, mcp });
  });

  afterEach(async () => await db.close());

  it('reports ready when tools are discovered', async () => {
    await core.adminRequest('/api/admin/mcp/servers', { method: 'PUT', body: { id: 'ombre', url: 'https://echo.sooya.icu/mcp', transport: 'streamable-http', token: 't', enabled: true } });
    const status = await core.adminRequest<{ connection: string; health: { state: string; detail?: string } }>('/api/admin/memory/status');
    expect(status.health.state).toBe('ready');
    expect(status.health.detail).toBe('14 tools');
    expect(status.connection).toBe('connected');
  });

  it('reports "no tools discovered" as degraded with the explicit reason', async () => {
    await core.adminRequest('/api/admin/mcp/servers', { method: 'PUT', body: { id: 'ombre', url: 'https://echo.sooya.icu/mcp', transport: 'streamable-http', token: 't', enabled: true } });
    mcp.tools = [];
    const status = await core.adminRequest<{ connection: string; health: { state: string; detail?: string } }>('/api/admin/memory/status');
    expect(status.health.state).toBe('degraded');
    expect(status.health.detail).toContain('no tools discovered');
    expect(status.connection).toBe('degraded');
  });

  it('does not report the transport unavailable when only discovery comes up empty', async () => {
    await core.adminRequest('/api/admin/mcp/servers', { method: 'PUT', body: { id: 'ombre', url: 'https://echo.sooya.icu/mcp', transport: 'streamable-http', token: 't', enabled: true } });
    mcp.tools = [];
    // health() stays degraded (session alive), not unavailable.
    const status = await core.adminRequest<{ health: { state: string } }>('/api/admin/memory/status');
    expect(status.health.state).toBe('degraded');
    // And no reconnect loop: one connect, one discovery.
    expect(mcp.connects).toHaveLength(1);
    expect(mcp.listToolCalls).toBe(1);
  });

  it('shares the connect timeout budget for discovery instead of the per-call 1.8s default', async () => {
    // Provider-level budget check: discovery must use the connect budget
    // (max(timeoutMs, connectTimeoutMs)), not the per-tool-call timeoutMs.
    // A discovery that fits the connect budget but exceeds the old 1.8s
    // default must succeed; one beyond the budget must abort.
    const { OmbreMcpMemoryProvider } = await import('../../src/memory/ombre-mcp-memory-provider.js');

    const within = new RecordingMcp();
    within.tools = OMBRE_TOOLS;
    within.listDelayMs = 200;
    const fast = new OmbreMcpMemoryProvider({
      mcp: within,
      timeoutMs: 50,
      getConfig: async () => ({ id: 'ombre', url: 'https://echo.sooya.icu/mcp', transport: 'streamable-http', connectTimeoutMs: 400 })
    });
    await expect(fast.health()).resolves.toMatchObject({ state: 'ready', detail: '14 tools' });

    const beyond = new RecordingMcp();
    beyond.tools = OMBRE_TOOLS;
    beyond.listDelayMs = 600;
    const slow = new OmbreMcpMemoryProvider({
      mcp: beyond,
      timeoutMs: 50,
      getConfig: async () => ({ id: 'ombre', url: 'https://echo.sooya.icu/mcp', transport: 'streamable-http', connectTimeoutMs: 400 })
    });
    const health = await slow.health();
    expect(health.state).toBe('unavailable');
  });
});
