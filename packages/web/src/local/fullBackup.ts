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
  importedModelCount?: number;
  importedPresetCount?: number;
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
  modelSettings: DatabaseRow[];
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
  models: Record<string, unknown>;
  presets: Array<Record<string, unknown>>;
}

const SERVER_MIGRATION_SECRETS_KEY = 'migration:server-secrets:v1';
const PROVIDER_SECRET_CAPABILITIES = new Set(['chat', 'vision', 'summary', 'director', 'embedding', 'image', 'tts', 'rerank']);
const MODEL_CAPABILITIES = ['chat', 'vision', 'summary', 'director', 'embedding', 'image', 'tts', 'rerank'] as const;
const OPTIONAL_CHAT_FALLBACK_CAPABILITIES = new Set(['vision', 'summary', 'director']);
const DOUBAO_SEARCH_DEFAULT_URL = 'https://open.feedcoopapi.com/search_api/web_search';
const TAVILY_SEARCH_DEFAULT_URL = 'https://api.tavily.com/search';

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
 * phone's business data, while IPA-local memory, built-in sticker state, MCP
 * runtime and OTA state survive. New migration packages also carry the server
 * model configuration because the server stores it outside SQLite in
 * CONFIG_DIR/models.json.
 *
 * Selected API keys are staged in the imported SQLite settings table. The Web
 * layer rebuilds provider_configs from the server model payload, moves the keys
 * into the existing Base 11 Keychain bridge, then removes the plaintext staging
 * row from SQLite.
 */
export async function importFullBackup(selected: PickedFullBackup, password?: string): Promise<PreparedFullImport> {
  const archive = nativePlugin('SOOYAArchive');
  const database = nativePlugin('SOOYADatabase');
  const serverMigration = /^SOOYA-server-to-IPA-/iu.test(selected.displayName);
  const localDb = serverMigration ? new CapacitorDatabase() : null;
  let preservedLocal: PreservedLocalState | null = null;
  let stagedServerSecrets: ServerMigrationSecretsPayload | null = null;
  let importedSecretCount = 0;
  let importedModelCount = 0;
  let importedPresetCount = 0;
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
      if (stagedServerSecrets && Object.keys(stagedServerSecrets.models).length > 0) {
        const imported = await applyServerMigrationModels(localDb, stagedServerSecrets);
        importedModelCount = imported.models;
        importedPresetCount = imported.presets;
      }
    }

    const integrity = await database.call<{ ok?: boolean }>('integrity', {});
    if (integrity.ok !== true) throw new Error('导入后的数据库完整性校验失败');

    if (localDb && stagedServerSecrets) {
      importedSecretCount = await applyServerMigrationSecrets(localDb, stagedServerSecrets);
    }

    await archive.call('commitFullImport', { importId: prepared.importId });
    return { ...prepared, importedSecretCount, importedModelCount, importedPresetCount };
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
    modelSettings: await db.query<DatabaseRow>("SELECT * FROM settings WHERE key IN ('models','modelPresets','modelSlots')"),
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

  await db.run("DELETE FROM settings WHERE key IN ('models','modelPresets','modelSlots')");
  await insertRows(db, 'settings', state.modelSettings);

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
  try { parsed = JSON.parse(raw); } catch { throw new Error('服务器迁移包中的 API Key / 模型配置记录无法解析'); }
  if (!isRecord(parsed) || parsed.version !== 1) throw new Error('服务器迁移包中的配置记录版本不受支持');
  return {
    version: 1,
    providerKeys: stringRecord(parsed.providerKeys),
    webSearchKeys: stringRecord(parsed.webSearchKeys),
    mcpTokens: stringRecord(parsed.mcpTokens),
    models: isRecord(parsed.models) ? parsed.models : {},
    presets: Array.isArray(parsed.presets) ? parsed.presets.filter(isRecord) : []
  };
}

async function applyServerMigrationModels(
  db: CapacitorDatabase,
  payload: ServerMigrationSecretsPayload
): Promise<{ models: number; presets: number }> {
  const timestamp = new Date().toISOString();
  let importedModels = 0;

  for (const capability of MODEL_CAPABILITIES) {
    const source = capability === 'director'
      ? (isRecord(payload.models.director) ? payload.models.director : payload.models.sticker)
      : payload.models[capability];
    if (!isRecord(source)) {
      if (OPTIONAL_CHAT_FALLBACK_CAPABILITIES.has(capability)) {
        await db.run('DELETE FROM provider_configs WHERE capability=?', [capability]);
      }
      continue;
    }

    const provider = normalizeProvider(stringValue(source.provider));
    const baseUrl = stringValue(source.baseUrl);
    const model = stringValue(source.model);
    if (provider === 'none' || !baseUrl || !model) {
      await db.run('DELETE FROM provider_configs WHERE capability=?', [capability]);
      continue;
    }

    const secretRef = validSecret(payload.providerKeys[capability]) ? `provider.${capability}.key` : null;
    const options = modelOptions(source);
    await db.run(
      `INSERT INTO provider_configs(capability,provider,base_url,model,secret_ref,enabled,options_json,created_at,updated_at)
       VALUES(?,?,?,?,?,1,?,?,?)
       ON CONFLICT(capability) DO UPDATE SET provider=excluded.provider,base_url=excluded.base_url,model=excluded.model,
       secret_ref=excluded.secret_ref,enabled=1,options_json=excluded.options_json,updated_at=excluded.updated_at`,
      [capability, provider, baseUrl, model, secretRef, JSON.stringify(options), timestamp, timestamp]
    );
    importedModels += 1;
  }

  if (isRecord(payload.models.webSearch)) {
    importedModels += await applyServerWebSearchModel(db, payload.models.webSearch, payload.webSearchKeys, timestamp);
  }

  await upsertSetting(db, 'models', payload.models, timestamp);
  const normalizedPresets = normalizeServerPresets(payload.presets);
  const existingPresets = await readSettingArray(db, 'modelPresets');
  const mergedPresets = new Map<string, Record<string, unknown>>();
  for (const preset of existingPresets) {
    const id = stringValue(preset.id);
    if (id) mergedPresets.set(id, preset);
  }
  for (const preset of normalizedPresets) mergedPresets.set(String(preset.id), preset);
  await upsertSetting(db, 'modelPresets', [...mergedPresets.values()], timestamp);
  await upsertSetting(db, 'modelSlots', [...MODEL_CAPABILITIES], timestamp);
  await db.run("DELETE FROM settings WHERE key='models.presets'");

  return { models: importedModels, presets: normalizedPresets.length };
}

async function applyServerWebSearchModel(
  db: CapacitorDatabase,
  raw: Record<string, unknown>,
  keys: Record<string, string>,
  timestamp: string
): Promise<number> {
  const enabled = raw.enabled === true;
  const providers = Array.isArray(raw.providers)
    ? raw.providers.filter((value): value is string => typeof value === 'string')
    : [];
  const localOrder = providers.filter((value) => value === 'doubao' || value === 'tavily');
  if (!enabled || localOrder.length === 0) {
    await db.run("DELETE FROM provider_configs WHERE capability='webSearch'");
    return 0;
  }

  const primary = localOrder[0] === 'tavily' ? 'tavily' : 'doubao';
  const fallback = localOrder[1] === 'tavily' ? 'tavily' : localOrder[1] === 'doubao' ? 'doubao' : null;
  const doubao = isRecord(raw.doubao) ? raw.doubao : {};
  const tavily = isRecord(raw.tavily) ? raw.tavily : {};
  const primaryConfig = primary === 'tavily' ? tavily : doubao;
  const secondaryConfig = primary === 'tavily' ? doubao : tavily;
  const primaryBaseUrl = stringValue(primaryConfig.baseUrl) || (primary === 'tavily' ? TAVILY_SEARCH_DEFAULT_URL : DOUBAO_SEARCH_DEFAULT_URL);
  const secondaryBaseUrl = fallback
    ? stringValue(secondaryConfig.baseUrl) || (fallback === 'tavily' ? TAVILY_SEARCH_DEFAULT_URL : DOUBAO_SEARCH_DEFAULT_URL)
    : '';
  const primarySecretRef = validSecret(keys[primary]) ? `provider.webSearch.${primary}.key` : null;
  const secondarySecretRef = fallback && validSecret(keys[fallback]) ? `provider.webSearch.${fallback}.key` : null;
  const options: Record<string, unknown> = {
    fallback,
    maxResults: boundedInteger(raw.maxResults, 5, 1, 20),
    timeoutMs: boundedInteger(raw.timeoutMs, 15_000, 1_000, 120_000),
    edition: doubao.edition === 'global' ? 'global' : 'custom',
    ...(secondaryBaseUrl ? { secondaryBaseUrl } : {}),
    ...(secondarySecretRef ? { secondarySecretRef } : {})
  };

  await db.run(
    `INSERT INTO provider_configs(capability,provider,base_url,model,secret_ref,enabled,options_json,created_at,updated_at)
     VALUES('webSearch',?,?,?, ?,1,?,?,?)
     ON CONFLICT(capability) DO UPDATE SET provider=excluded.provider,base_url=excluded.base_url,model=excluded.model,
     secret_ref=excluded.secret_ref,enabled=1,options_json=excluded.options_json,updated_at=excluded.updated_at`,
    [primary, primaryBaseUrl, '', primarySecretRef, JSON.stringify(options), timestamp, timestamp]
  );
  return 1;
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

async function upsertSetting(db: CapacitorDatabase, key: string, value: unknown, timestamp: string): Promise<void> {
  await db.run(
    `INSERT INTO settings(key,value_json,updated_at) VALUES(?,?,?)
     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`,
    [key, JSON.stringify(value), timestamp]
  );
}

async function readSettingArray(db: CapacitorDatabase, key: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.query<{ value_json: string }>('SELECT value_json FROM settings WHERE key=?', [key]);
  const raw = rows[0]?.value_json;
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function normalizeServerPresets(value: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of value) {
    const id = stringValue(raw.id);
    const name = stringValue(raw.name);
    const slot = stringValue(raw.slot);
    const provider = stringValue(raw.provider);
    const model = stringValue(raw.model);
    if (!id || !name || !MODEL_CAPABILITIES.includes(slot as (typeof MODEL_CAPABILITIES)[number]) || !provider || !model) continue;
    out.push({
      id: id.slice(0, 64),
      name: name.slice(0, 80),
      slot,
      provider,
      model: model.slice(0, 200),
      baseUrl: stringValue(raw.baseUrl).slice(0, 300),
      notes: stringValue(raw.notes).slice(0, 300)
    });
  }
  return out.slice(0, 60);
}

function modelOptions(raw: Record<string, unknown>): Record<string, unknown> {
  const excluded = new Set(['provider', 'model', 'baseUrl', 'apiKey', 'apiKeyEnv', 'configSource', 'secretRef', 'apiKeyConfigured', 'apiKeyBound', 'options']);
  const options = Object.fromEntries(Object.entries(raw).filter(([key]) => !excluded.has(key)));
  if (typeof raw.supportsTools === 'boolean') options.tools = raw.supportsTools;
  return options;
}

function normalizeProvider(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  if (!normalized || normalized === 'none') return 'none';
  if (normalized.includes('anthropic')) return 'anthropic';
  return normalized;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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
