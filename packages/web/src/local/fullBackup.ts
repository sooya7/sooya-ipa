import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { LATEST_SCHEMA_VERSION, migrateDatabase } from '@sooya/core/app';
import type { DatabaseValue } from '@sooya/core/platform';
import { CapacitorDatabase } from './nativeBoot.js';

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
}

interface RestoreResult {
  preRestoreBackupFileName?: string;
}

type DatabaseRow = Record<string, unknown>;

interface PreservedLocalState {
  // Hybrid memory is phone-local state synchronized with Ombre; the server
  // migration archive deliberately contains no memory facts.
  memories: DatabaseRow[];
  syncState: DatabaseRow[];
  syncOutbox: DatabaseRow[];
  syncCursors: DatabaseRow[];
  tombstones: DatabaseRow[];
  localMemoryReceipts: DatabaseRow[];

  // These tables describe the IPA runtime, not server business data. Their
  // Keychain values live outside SQLite and survive the restore, so the DB
  // references/configuration must survive as well.
  mcpServers: DatabaseRow[];
  mcpPolicies: DatabaseRow[];
  secretRefs: DatabaseRow[];
  providerConfigs: DatabaseRow[];
  appPreferences: DatabaseRow[];
  notificationCapabilities: DatabaseRow[];
  localUpdateState: DatabaseRow[];
  localBackupMetadata: DatabaseRow[];
}

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
 * phone's business data, while IPA-local runtime configuration and hybrid
 * memory state survive. Server memories/stickers are intentionally absent.
 */
export async function importFullBackup(selected: PickedFullBackup, password?: string): Promise<PreparedFullImport> {
  const archive = nativePlugin('SOOYAArchive');
  const database = nativePlugin('SOOYADatabase');
  const serverMigration = /^SOOYA-server-to-IPA-/iu.test(selected.displayName);
  const localDb = serverMigration ? new CapacitorDatabase() : null;
  let preservedLocal: PreservedLocalState | null = null;
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
      // Server snapshots currently stop at schema v35. Bring the restored copy
      // to the current IPA schema before putting phone-local state back.
      await migrateDatabase(localDb);
      await restoreLocalState(localDb, preservedLocal);
    }

    const integrity = await database.call<{ ok?: boolean }>('integrity', {});
    if (integrity.ok !== true) throw new Error('导入后的数据库完整性校验失败');

    await archive.call('commitFullImport', { importId: prepared.importId });
    return prepared;
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
  // The migration archive intentionally contains no server memory facts. Restore
  // the phone's local copy, including unsynced outbox/conflict/cursor state.
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

  // Preserve all IPA-local provider/MCP/OTA preferences, not just Ombre. The
  // corresponding Keychain secrets are outside the SQLite file and were never
  // touched by the server migration restore.
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
