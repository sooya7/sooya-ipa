import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { LATEST_SCHEMA_VERSION, migrateDatabase } from '@sooya/core/app';
import type { DatabaseValue } from '@sooya/core/platform';
import { CapacitorDatabase, CapacitorSecrets } from './nativeBoot.js';

interface NativePluginCall {
  call<T = Record<string, unknown>>(method: string, options: Record<string, unknown>): Promise<T>;
}

export interface FullBackupExportResult {
  name: string;
  path: string;
  url: string;
  bytes: number;
  fileCount: number;
  sha256: string;
  secretsIncluded: boolean;
}

export interface PickedFullBackup {
  archiveName: string;
  displayName: string;
  bytes: number;
}

interface PreparedFullImport {
  importId: string;
  restoreName: string;
  createdAt: string;
  schemaVersion: number;
  mediaIncluded: boolean;
  secretsIncluded: boolean;
  importedSecretCount?: number;
}

interface RestoreResult {
  preRestoreBackupFileName?: string;
}

type DatabaseRow = Record<string, unknown>;

interface PreservedLocalState {
  memories: DatabaseRow[];
  syncState: DatabaseRow[];
  syncOutbox: DatabaseRow[];
  syncCursors: DatabaseRow[];
  tombstones: DatabaseRow[];
  localMemoryReceipts: DatabaseRow[];
  builtinStickerMedia: DatabaseRow[];
  builtinStickers: DatabaseRow[];
  builtinStickerSearch: DatabaseRow[];
  builtinStickerMarkers: DatabaseRow[];
  mcpServers: DatabaseRow[];
  mcpPolicies: DatabaseRow[];
  secretRefs: DatabaseRow[];
  providerConfigs: DatabaseRow[];
  appPreferences: DatabaseRow[];
  notificationCapabilities: DatabaseRow[];
  localUpdateState: DatabaseRow[];
  localBackupMetadata: DatabaseRow[];
}

interface ServerMigrationSecretsPayload {
  version: 1;
  providerKeys: Record<string, string>;
  webSearchKeys: Record<string, string>;
  mcpTokens: Record<string, string>;
}

const SERVER_MIGRATION_SECRETS_KEY = 'migration:server-secrets:v1';
const PROVIDER_SECRET_CAPABILITIES = new Set(['chat', 'vision', 'summary', 'director', 'embedding', 'image', 'tts', 'rerank']);

function nativePlugin(name: string): NativePluginCall {
  const plugins = (Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins ?? {};
  const plugin = plugins[name];
  if (!plugin) throw new Error(`native plugin ${name} is unavailable`);
  return plugin as NativePluginCall;
}

export function fullBackupAvailable(): boolean {
  if (!Capacitor.isNativePlatform()) return false;
  const plugins = (Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins ?? {};
  return Boolean(plugins.SOOYAArchive && plugins.SOOYADatabase);
}

export async function exportFullBackup(options: { includeSecrets: boolean; password?: string }): Promise<FullBackupExportResult> {
  const archive = nativePlugin('SOOYAArchive');
  const password = options.password?.trim() ?? '';
  if (options.includeSecrets && password.length < 10) throw new Error('包含密钥时，备份密码至少需要 10 个字符');

  const result = await archive.call<FullBackupExportResult>('createFullBackup', {
    schemaVersion: LATEST_SCHEMA_VERSION,
    includeSecrets: options.includeSecrets,
    ...(options.includeSecrets ? { password } : {})
  });

  try {
    await Share.share({
      title: 'SOOYA 完整备份',
      dialogTitle: '导出 SOOYA 完整备份',
      files: [result.url]
    });
    return result;
  } finally {
    await archive.call('cleanup', { path: result.path }).catch(() => undefined);
  }
}

export async function pickFullBackup(): Promise<PickedFullBackup | null> {
  const result = await nativePlugin('SOOYAArchive').call<PickedFullBackup & { cancelled?: boolean }>('pickFullBackup', {});
  if (result.cancelled) return null;
  if (!result.archiveName) throw new Error('没有选择可导入的备份文件');
  return result;
}

/**
 * Normal IPA backup restores remain full replacements. A server migration ZIP
 * (SOOYA-server-to-IPA-*.zip) is different: server chat/life/media become the
 * phone's business data, while IPA-local runtime configuration, built-in
 * sticker state and hybrid memory state survive. Server memories/stickers are
 * intentionally absent from the migration package.
 *
 * New server migration packages may also stage selected API keys in the
 * imported SQLite settings table. The Web layer moves those values into the
 * existing Base 11 Keychain bridge, binds them to the phone's current provider
 * / MCP rows, then removes the plaintext staging row from SQLite.
 */
export async function importFullBackup(selected: PickedFullBackup, password?: string): Promise<PreparedFullImport> {
  const archive = nativePlugin('SOOYAArchive');
  const database = nativePlugin('SOOYADatabase');
  const serverMigration = /^SOOYA-server-to-IPA-/iu.test(selected.displayName);
  const localDb = serverMigration ? new CapacitorDatabase() : null;
  let preservedLocal: PreservedLocalState | null = null;
  let stagedServerSecrets: ServerMigrationSecretsPayload | null = null;
  let importedSecretCount = 0;
  let prepared: PreparedFullImport | null = null;
  let restore: RestoreResult | null = null;

  try {
    if (localDb) {
      await localDb.open();
      preservedLocal = await captureLocalState(localDb);
    }

    prepared = await archive.call<PreparedFullImport>('prepareFullImport', {
      archiveName: selected.archiveName,
      currentSchemaVersion: LATEST_SCHEMA_VERSION,
      ...(password?.trim() ? { password: password.trim() } : {})
    });

    restore = await database.call<RestoreResult>('restore', { name: prepared.restoreName });

    if (localDb && preservedLocal) {
      await migrateDatabase(localDb);
      stagedServerSecrets = await readServerMigrationSecrets(localDb);
      await restoreLocalState(localDb, preservedLocal);
    }

    const integrity = await database.call<{ ok?: boolean }>('integrity', {});
    if (integrity.ok !== true) throw new Error('导入后的数据库完整性校验失败');

    if (localDb && stagedServerSecrets) {
      importedSecretCount = await applyServerMigrationSecrets(localDb, stagedServerSecrets);
    }

    await archive.call('commitFullImport', { importId: prepared.importId });
    return { ...prepared, importedSecretCount };
  } catch (error) {
    if (restore?.preRestoreBackupFileName) {
      await database.call('restore', { name: restore.preRestoreBackupFileName }).catch(() => undefined);
    }
    if (prepared?.importId) {
      await archive.call('abortFullImport', { importId: prepared.importId }).catch(() => undefined);
    } else {
      await archive.call('cleanup', { path: selected.archiveName }).catch(() => undefined);
    }
    throw error;
  }
}

async function captureLocalState(db: CapacitorDatabase): Promise<PreservedLocalState> {
  return {
    memories: await db.query<DatabaseRow>('SELECT * FROM memories'),
    syncState: await db.query<DatabaseRow>('SELECT * FROM memory_sync_state'),
    syncOutbox: await db.query<DatabaseRow>('SELECT * FROM memory_sync_outbox'),
    syncCursors: await db.query<DatabaseRow>('SELECT * FROM memory_sync_cursors'),
    tombstones: await db.query<DatabaseRow>('SELECT * FROM memory_tombstones'),
    localMemoryReceipts: await db.query<DatabaseRow>('SELECT * FROM local_memory_receipts'),
    builtinStickerMedia: await db.query<DatabaseRow>("SELECT * FROM media WHERE kind='sticker' AND origin='builtin'"),
    builtinStickers: await db.query<DatabaseRow>("SELECT * FROM stickers WHERE media_id IN (SELECT id FROM media WHERE kind='sticker' AND origin='builtin')"),
    builtinStickerSearch: await db.query<DatabaseRow>("SELECT * FROM sticker_semantics_fts WHERE sticker_id IN (SELECT id FROM stickers WHERE media_id IN (SELECT id FROM media WHERE kind='sticker' AND origin='builtin'))"),
    builtinStickerMarkers: await db.query<DatabaseRow>("SELECT * FROM settings WHERE key LIKE 'builtin-stickers:%'"),
    mcpServers: await db.query<DatabaseRow>('SELECT * FROM mcp_servers'),
    mcpPolicies: await db.query<DatabaseRow>('SELECT * FROM mcp_tool_policies'),
    secretRefs: await db.query<DatabaseRow>('SELECT * FROM secret_refs'),
    providerConfigs: await db.query<DatabaseRow>('SELECT * FROM provider_configs'),
    appPreferences: await db.query<DatabaseRow>('SELECT * FROM app_preferences'),
    notificationCapabilities: await db.query<DatabaseRow>('SELECT * FROM notification_capabilities'),
    localUpdateState: await db.query<DatabaseRow>('SELECT * FROM local_update_state'),
    localBackupMetadata: await db.query<DatabaseRow>('SELECT * FROM local_backup_metadata')
  };
}

async function restoreLocalState(db: CapacitorDatabase, state: PreservedLocalState): Promise<void> {
  await clearTables(db, [
    'memory_sync_outbox', 'memory_sync_state', 'memory_sync_cursors', 'memory_tombstones',
    'local_memory_receipts', 'memories'
  ]);
  await insertRows(db, 'memories', state.memories);
  await insertRows(db, 'local_memory_receipts', state.localMemoryReceipts);
  await insertRows(db, 'memory_sync_state', state.syncState);
  await insertRows(db, 'memory_sync_outbox', state.syncOutbox);
  await insertRows(db, 'memory_sync_cursors', state.syncCursors);
  await insertRows(db, 'memory_tombstones', state.tombstones);

  await db.run('DELETE FROM sticker_semantics_fts');
  await db.run('DELETE FROM stickers');
  await db.run("DELETE FROM media WHERE kind='sticker'");
  await db.run("DELETE FROM settings WHERE key LIKE 'builtin-stickers:%'");
  await insertRows(db, 'media', state.builtinStickerMedia);
  await insertRows(db, 'stickers', state.builtinStickers);
  await insertRows(db, 'sticker_semantics_fts', state.builtinStickerSearch);
  await insertRows(db, 'settings', state.builtinStickerMarkers);

  await clearTables(db, [
    'mcp_tool_policies', 'mcp_servers', 'secret_refs', 'provider_configs',
    'app_preferences', 'notification_capabilities', 'local_update_state',
    'local_backup_metadata'
  ]);
  await insertRows(db, 'secret_refs', state.secretRefs);
  await insertRows(db, 'mcp_servers', state.mcpServers);
  await insertRows(db, 'mcp_tool_policies', state.mcpPolicies);
  await insertRows(db, 'provider_configs', state.providerConfigs);
  await insertRows(db, 'app_preferences', state.appPreferences);
  await insertRows(db, 'notification_capabilities', state.notificationCapabilities);
  await insertRows(db, 'local_update_state', state.localUpdateState);
  await insertRows(db, 'local_backup_metadata', state.localBackupMetadata);

  try { await db.execute("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')"); } catch { /* derived index; startup can rebuild later */ }
}

async function readServerMigrationSecrets(db: CapacitorDatabase): Promise<ServerMigrationSecretsPayload | null> {
  const rows = await db.query<{ value_json: string }>('SELECT value_json FROM settings WHERE key=?', [SERVER_MIGRATION_SECRETS_KEY]);
  const raw = rows[0]?.value_json;
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('服务器迁移包中的 API Key 记录无法解析'); }
  if (!isRecord(parsed) || parsed.version !== 1) throw new Error('服务器迁移包中的 API Key 记录版本不受支持');
  return {
    version: 1,
    providerKeys: stringRecord(parsed.providerKeys),
    webSearchKeys: stringRecord(parsed.webSearchKeys),
    mcpTokens: stringRecord(parsed.mcpTokens)
  };
}

async function applyServerMigrationSecrets(db: CapacitorDatabase, payload: ServerMigrationSecretsPayload): Promise<number> {
  const secrets = new CapacitorSecrets();
  let imported = 0;

  for (const [capability, value] of Object.entries(payload.providerKeys)) {
    if (!PROVIDER_SECRET_CAPABILITIES.has(capability) || !validSecret(value)) continue;
    const rows = await db.query<{ secret_ref: string | null }>('SELECT secret_ref FROM provider_configs WHERE capability=?', [capability]);
    const existingRef = rows[0]?.secret_ref?.trim() ?? '';
    const ref = existingRef || `provider.${capability}.key`;
    await secrets.set(ref, value);
    await upsertSecretRef(db, ref, 'provider-api-key', { capability, source: 'server-migration' });
    if (rows.length > 0 && !existingRef) await db.run('UPDATE provider_configs SET secret_ref=?,updated_at=? WHERE capability=?', [ref, new Date().toISOString(), capability]);
    imported += 1;
  }

  const webSearchRow = (await db.query<{ provider: string; secret_ref: string | null; options_json: string }>(
    "SELECT provider,secret_ref,options_json FROM provider_configs WHERE capability='webSearch'"
  ))[0];
  let webSearchOptions = parseRecord(webSearchRow?.options_json);
  for (const identity of ['doubao', 'tavily'] as const) {
    const value = payload.webSearchKeys[identity];
    if (!validSecret(value)) continue;
    const primary = webSearchRow?.provider === identity;
    const secondary = webSearchOptions.fallback === identity;
    const existingRef = primary
      ? webSearchRow?.secret_ref?.trim() ?? ''
      : secondary && typeof webSearchOptions.secondarySecretRef === 'string' ? webSearchOptions.secondarySecretRef.trim() : '';
    const ref = existingRef || `provider.webSearch.${identity}.key`;
    await secrets.set(ref, value);
    await upsertSecretRef(db, ref, 'provider-api-key', { capability: 'webSearch', provider: identity, source: 'server-migration' });
    if (webSearchRow && !existingRef) {
      if (primary) {
        await db.run("UPDATE provider_configs SET secret_ref=?,updated_at=? WHERE capability='webSearch'", [ref, new Date().toISOString()]);
      } else if (secondary) {
        webSearchOptions = { ...webSearchOptions, secondarySecretRef: ref };
        await db.run("UPDATE provider_configs SET options_json=?,updated_at=? WHERE capability='webSearch'", [JSON.stringify(webSearchOptions), new Date().toISOString()]);
      }
    }
    imported += 1;
  }

  for (const [serverId, value] of Object.entries(payload.mcpTokens)) {
    if (!validIdentifierSegment(serverId) || !validSecret(value)) continue;
    const rows = await db.query<{ secret_ref: string | null }>('SELECT secret_ref FROM mcp_servers WHERE id=?', [serverId]);
    const existingRef = rows[0]?.secret_ref?.trim() ?? '';
    const ref = existingRef || `mcp.${serverId}.token`;
    await secrets.set(ref, value);
    await upsertSecretRef(db, ref, 'mcp-token', { serverId, source: 'server-migration' });
    if (rows.length > 0 && !existingRef) await db.run('UPDATE mcp_servers SET secret_ref=?,auth_type=?,updated_at=? WHERE id=?', [ref, 'bearer', new Date().toISOString(), serverId]);
    imported += 1;
  }

  await db.run('DELETE FROM settings WHERE key=?', [SERVER_MIGRATION_SECRETS_KEY]);
  return imported;
}

async function upsertSecretRef(db: CapacitorDatabase, ref: string, kind: string, meta: Record<string, unknown>): Promise<void> {
  const timestamp = new Date().toISOString();
  await db.run(
    `INSERT INTO secret_refs(ref,kind,configured,created_at,updated_at,meta_json) VALUES(?,?,?,?,?,?)
     ON CONFLICT(ref) DO UPDATE SET kind=excluded.kind,configured=1,updated_at=excluded.updated_at,meta_json=excluded.meta_json`,
    [ref, kind, 1, timestamp, timestamp, JSON.stringify(meta)]
  );
}

async function clearTables(db: CapacitorDatabase, tables: string[]): Promise<void> {
  for (const table of tables) {
    assertIdentifier(table);
    await db.run(`DELETE FROM ${table}`);
  }
}

async function insertRows(db: CapacitorDatabase, table: string, rows: DatabaseRow[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!);
  if (columns.length === 0) return;
  assertIdentifier(table);
  for (const column of columns) assertIdentifier(column);
  const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
  for (const row of rows) {
    await db.run(sql, columns.map((column) => asDatabaseValue(row[column])));
  }
}

function assertIdentifier(value: string): void {
  if (!/^[a-z_][a-z0-9_]*$/iu.test(value)) throw new Error('不安全的数据库标识符');
}

function asDatabaseValue(value: unknown): DatabaseValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' || value instanceof Uint8Array || value instanceof ArrayBuffer) return value;
  throw new Error(`无法恢复的数据库值类型：${Object.prototype.toString.call(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && validSecret(entry[1])));
}

function parseRecord(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  try { const parsed = JSON.parse(value) as unknown; return isRecord(parsed) ? parsed : {}; } catch { return {}; }
}

function validSecret(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 64 * 1024;
}

function validIdentifierSegment(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(value);
}
