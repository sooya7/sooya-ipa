import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { LATEST_SCHEMA_VERSION, migrateDatabase } from '@sooya/core/app';
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

interface PreservedMemoryState {
  memories: DatabaseRow[];
  syncState: DatabaseRow[];
  syncOutbox: DatabaseRow[];
  syncCursors: DatabaseRow[];
  tombstones: DatabaseRow[];
  ombreServers: DatabaseRow[];
  ombrePolicies: DatabaseRow[];
  ombreSecretRefs: DatabaseRow[];
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
 * (SOOYA-server-to-IPA-*.zip) is different: chat/life/media come from the
 * server, while the phone keeps its already-configured Ombre memory state.
 * Server memories are intentionally absent from that archive.
 */
export async function importFullBackup(selected: PickedFullBackup, password?: string): Promise<PreparedFullImport> {
  const archive = nativePlugin('SOOYAArchive');
  const database = nativePlugin('SOOYADatabase');
  const serverMigration = /^SOOYA-server-to-IPA-/iu.test(selected.displayName);
  const localDb = serverMigration ? new CapacitorDatabase() : null;
  let preservedMemory: PreservedMemoryState | null = null;
  let prepared: PreparedFullImport | null = null;
  let restore: RestoreResult | null = null;

  try {
    if (localDb) {
      await localDb.open();
      preservedMemory = await captureMemoryState(localDb);
    }

    prepared = await archive.call<PreparedFullImport>('prepareFullImport', {
      archiveName: selected.archiveName,
      currentSchemaVersion: LATEST_SCHEMA_VERSION,
      ...(password?.trim() ? { password: password.trim() } : {})
    });

    restore = await database.call<RestoreResult>('restore', { name: prepared.restoreName });

    if (localDb && preservedMemory) {
      // Server snapshots currently stop at schema v35. Bring the restored copy
      // to the current IPA schema before putting the phone's hybrid memory state
      // back. This also recreates mcp_servers and all v46 sync tables.
      await migrateDatabase(localDb);
      await restoreMemoryState(localDb, preservedMemory);
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

async function captureMemoryState(db: CapacitorDatabase): Promise<PreservedMemoryState> {
  const ombreServers = await db.query<DatabaseRow>("SELECT * FROM mcp_servers WHERE id='ombre'");
  return {
    memories: await db.query<DatabaseRow>('SELECT * FROM memories'),
    syncState: await db.query<DatabaseRow>('SELECT * FROM memory_sync_state'),
    syncOutbox: await db.query<DatabaseRow>('SELECT * FROM memory_sync_outbox'),
    syncCursors: await db.query<DatabaseRow>('SELECT * FROM memory_sync_cursors'),
    tombstones: await db.query<DatabaseRow>('SELECT * FROM memory_tombstones'),
    ombreServers,
    ombrePolicies: await db.query<DatabaseRow>("SELECT * FROM mcp_tool_policies WHERE server_id='ombre'"),
    ombreSecretRefs: ombreServers.length === 0
      ? []
      : await db.query<DatabaseRow>("SELECT * FROM secret_refs WHERE ref IN (SELECT secret_ref FROM mcp_servers WHERE id='ombre' AND secret_ref IS NOT NULL)")
  };
}

async function restoreMemoryState(db: CapacitorDatabase, state: PreservedMemoryState): Promise<void> {
  // The server migration archive intentionally contains no memory facts. Clear
  // anything unexpected before restoring the phone's authoritative local copy.
  await db.run('DELETE FROM memories');
  await insertRows(db, 'memories', state.memories);
  await insertRows(db, 'memory_sync_state', state.syncState);
  await insertRows(db, 'memory_sync_outbox', state.syncOutbox);
  await insertRows(db, 'memory_sync_cursors', state.syncCursors);
  await insertRows(db, 'memory_tombstones', state.tombstones);

  // Keychain values survive database restore. Reinstall only the DB references
  // and Ombre MCP row/policies that point at those existing native secrets.
  await db.run("DELETE FROM mcp_tool_policies WHERE server_id='ombre'");
  await db.run("DELETE FROM mcp_servers WHERE id='ombre'");
  await insertRows(db, 'secret_refs', state.ombreSecretRefs);
  await insertRows(db, 'mcp_servers', state.ombreServers);
  await insertRows(db, 'mcp_tool_policies', state.ombrePolicies);

  try { await db.execute("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')"); } catch { /* derived index; startup can rebuild later */ }
}

async function insertRows(db: CapacitorDatabase, table: string, rows: DatabaseRow[]): Promise<void> {
  if (rows.length === 0) return;
  const columns = Object.keys(rows[0]!);
  if (columns.length === 0) return;
  const identifier = /^[a-z_][a-z0-9_]*$/iu;
  if (!identifier.test(table) || columns.some((column) => !identifier.test(column))) throw new Error('不安全的数据库列名');
  const sql = `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
  for (const row of rows) {
    await db.run(sql, columns.map((column) => row[column]) as never[]);
  }
}
