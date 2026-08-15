import type { LocalDatabase } from '../platform/database.js';
import type { McpServerConfig, McpTransport } from '../platform/mcp.js';
import { nowIso, queryOne, runOperation, runTransaction, safeJson } from './database.js';

export interface McpServerRow extends McpServerConfig {
  name: string;
  state: string;
  lastError: string | null;
  lastConnectedAt: string | null;
  lastRefreshAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpToolPolicyRow {
  serverId: string;
  remoteName: string;
  canonicalName: string;
  risk: string;
  phases: string[];
  authorized: boolean;
  schemaHash: string | null;
  updatedAt: string;
}

interface ServerDbRow {
  id: string; name: string; enabled: number; url: string; transport: McpTransport; auth_type: string; secret_ref: string | null;
  required: number; connect_timeout_ms: number; tool_timeout_ms: number; state: string; last_error: string | null;
  last_connected_at: string | null; last_refresh_at: string | null; created_at: string; updated_at: string;
}

export class McpRepository {
  constructor(private readonly db: LocalDatabase, private readonly now: () => Date = () => new Date()) {}

  async listServers(): Promise<McpServerRow[]> {
    await this.promoteLegacyOmbreAlias();
    return (await this.db.query<ServerDbRow>('SELECT * FROM mcp_servers ORDER BY created_at')).map(toServer);
  }

  async getServer(id: string): Promise<McpServerRow | undefined> {
    if (id === 'ombre') await this.promoteLegacyOmbreAlias();
    const row = await queryOne<ServerDbRow>(this.db, 'SELECT * FROM mcp_servers WHERE id=?', [id]);
    return row ? toServer(row) : undefined;
  }

  async upsertServer(input: Partial<McpServerConfig> & { id: string; name?: string }): Promise<McpServerRow> {
    const normalizedName = input.name?.trim();
    const id = isGeneratedMcpId(input.id) && isOmbreAlias(normalizedName) ? 'ombre' : input.id;
    const existing = await this.getServer(id);
    const timestamp = nowIso(this.now);
    await this.db.run(
      `INSERT INTO mcp_servers(id,name,enabled,url,transport,auth_type,secret_ref,required,connect_timeout_ms,tool_timeout_ms,state,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,enabled=excluded.enabled,url=excluded.url,transport=excluded.transport,
       auth_type=excluded.auth_type,secret_ref=excluded.secret_ref,required=excluded.required,connect_timeout_ms=excluded.connect_timeout_ms,
       tool_timeout_ms=excluded.tool_timeout_ms,updated_at=excluded.updated_at`,
      [id, normalizedName || existing?.name || id, input.enabled === false ? 0 : 1, input.url ?? existing?.url ?? '', input.transport ?? existing?.transport ?? 'streamable-http',
        input.secretKey ? 'bearer' : 'none', input.secretKey ?? existing?.secretKey ?? null, input.required ? 1 : 0,
        input.connectTimeoutMs ?? existing?.connectTimeoutMs ?? 30_000, input.toolTimeoutMs ?? existing?.toolTimeoutMs ?? 15_000,
        existing?.state ?? 'closed', existing?.createdAt ?? timestamp, timestamp]
    );
    return (await this.getServer(id))!;
  }

  async removeServer(id: string): Promise<void> { await this.db.run('DELETE FROM mcp_servers WHERE id=?', [id]); }

  async setState(id: string, state: string, error: string | null = null): Promise<void> {
    const timestamp = nowIso(this.now);
    await this.db.run('UPDATE mcp_servers SET state=?,last_error=?,last_connected_at=CASE WHEN ?=\'ready\' THEN ? ELSE last_connected_at END,updated_at=? WHERE id=?', [state, error, state, timestamp, timestamp, id]);
  }

  async setRefreshed(id: string): Promise<void> { await this.db.run('UPDATE mcp_servers SET last_refresh_at=?,updated_at=? WHERE id=?', [nowIso(this.now), nowIso(this.now), id]); }

  async listPolicies(serverId?: string): Promise<McpToolPolicyRow[]> {
    const rows = serverId
      ? await this.db.query<{ server_id: string; remote_name: string; canonical_name: string; risk: string; phases_json: string; authorized: number; schema_hash: string | null; updated_at: string }>('SELECT * FROM mcp_tool_policies WHERE server_id=? ORDER BY remote_name', [serverId])
      : await this.db.query<{ server_id: string; remote_name: string; canonical_name: string; risk: string; phases_json: string; authorized: number; schema_hash: string | null; updated_at: string }>('SELECT * FROM mcp_tool_policies ORDER BY server_id,remote_name');
    return rows.map((row) => ({ serverId: row.server_id, remoteName: row.remote_name, canonicalName: row.canonical_name, risk: row.risk, phases: safeJson(row.phases_json, []), authorized: row.authorized === 1, schemaHash: row.schema_hash, updatedAt: row.updated_at }));
  }

  async upsertPolicy(input: Omit<McpToolPolicyRow, 'updatedAt'>): Promise<void> {
    await this.db.run(
      `INSERT INTO mcp_tool_policies(server_id,remote_name,canonical_name,risk,phases_json,authorized,schema_hash,updated_at)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(server_id,remote_name) DO UPDATE SET canonical_name=excluded.canonical_name,risk=excluded.risk,phases_json=excluded.phases_json,authorized=excluded.authorized,schema_hash=excluded.schema_hash,updated_at=excluded.updated_at`,
      [input.serverId, input.remoteName, input.canonicalName, input.risk, JSON.stringify(input.phases), input.authorized ? 1 : 0, input.schemaHash ?? null, nowIso(this.now)]
    );
  }

  /**
   * Early IPA builds labelled the first field "名称 / ID" but submitted only
   * `name`; LocalCore then generated an opaque `mcp_*` primary key. Ombre's
   * memory adapter intentionally resolves the reserved id `ombre`, so repair
   * those rows in-place (including the common `omber` typo) and carry their
   * tool policies with them. The Keychain secret reference is opaque and can
   * remain unchanged.
   */
  private async promoteLegacyOmbreAlias(): Promise<void> {
    const exact = await queryOne<{ id: string }>(this.db, 'SELECT id FROM mcp_servers WHERE id=\'ombre\' LIMIT 1');
    if (exact) return;
    const legacy = await queryOne<{ id: string }>(
      this.db,
      `SELECT id FROM mcp_servers
       WHERE lower(trim(name)) IN ('ombre','omber')
       ORDER BY CASE lower(trim(name)) WHEN 'ombre' THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1`
    );
    if (!legacy || legacy.id === 'ombre') return;
    await runTransaction(this.db, [
      runOperation(
        `INSERT INTO mcp_servers(
           id,name,enabled,url,transport,auth_type,secret_ref,required,connect_timeout_ms,tool_timeout_ms,protocol_mode,
           state,last_error,last_connected_at,last_refresh_at,created_at,updated_at
         )
         SELECT 'ombre',name,enabled,url,transport,auth_type,secret_ref,required,connect_timeout_ms,tool_timeout_ms,protocol_mode,
                state,last_error,last_connected_at,last_refresh_at,created_at,updated_at
         FROM mcp_servers WHERE id=?`,
        [legacy.id]
      ),
      runOperation('UPDATE mcp_tool_policies SET server_id=\'ombre\' WHERE server_id=?', [legacy.id]),
      runOperation('DELETE FROM mcp_servers WHERE id=?', [legacy.id])
    ]);
  }
}

function toServer(row: ServerDbRow): McpServerRow {
  return { id: row.id, name: row.name, enabled: row.enabled === 1, url: row.url, transport: row.transport, required: row.required === 1,
    secretKey: row.secret_ref ?? undefined, connectTimeoutMs: row.connect_timeout_ms, toolTimeoutMs: row.tool_timeout_ms, state: row.state,
    lastError: row.last_error, lastConnectedAt: row.last_connected_at, lastRefreshAt: row.last_refresh_at, createdAt: row.created_at, updatedAt: row.updated_at };
}

function isGeneratedMcpId(id: string): boolean {
  return /^mcp_[a-z0-9]+$/iu.test(id);
}

function isOmbreAlias(value: string | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized === 'ombre' || normalized === 'omber';
}
