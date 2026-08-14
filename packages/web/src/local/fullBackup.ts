import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { LATEST_SCHEMA_VERSION } from '@sooya/core/app';

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

export async function importFullBackup(selected: PickedFullBackup, password?: string): Promise<PreparedFullImport> {
  const archive = nativePlugin('SOOYAArchive');
  const database = nativePlugin('SOOYADatabase');
  let prepared: PreparedFullImport | null = null;
  let restore: RestoreResult | null = null;

  try {
    prepared = await archive.call<PreparedFullImport>('prepareFullImport', {
      archiveName: selected.archiveName,
      currentSchemaVersion: LATEST_SCHEMA_VERSION,
      ...(password?.trim() ? { password: password.trim() } : {})
    });

    restore = await database.call<RestoreResult>('restore', { name: prepared.restoreName });
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
