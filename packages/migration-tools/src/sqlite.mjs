import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import { assertRegularFile, sha256File } from './common.mjs';

const require = createRequire(import.meta.url);

export function loadBetterSqlite3() {
  const candidates = ['better-sqlite3'];
  const failures = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      failures.push(`${candidate}: ${error?.code ?? error?.name ?? 'load failed'}`);
    }
  }
  throw new Error(`better-sqlite3 is unavailable (${failures.join('; ')})`);
}

export function openSqliteBackupSource(file) {
  const Database = loadBetterSqlite3();
  const database = new Database(path.resolve(file), { readonly: true, fileMustExist: true });
  return {
    backup: (destination, options) => database.backup(destination, options),
    close: () => database.close(),
    get open() { return database.open; }
  };
}

export async function verifySqliteSnapshot(file) {
  await assertRegularFile(file, 'SQLite snapshot');
  const Database = loadBetterSqlite3();
  const database = new Database(path.resolve(file), { readonly: true, fileMustExist: true });
  try {
    const rows = database.pragma('integrity_check');
    const result = Object.values(rows[0] ?? {})[0];
    if (result !== 'ok') throw new Error(`SQLite integrity_check failed: ${rows.map((row) => Object.values(row)[0]).join('; ')}`);
    const foreignKeys = database.pragma('foreign_key_check');
    if (foreignKeys.length > 0) throw new Error(`SQLite foreign_key_check failed: ${foreignKeys.length} violation(s)`);
  } finally {
    database.close();
    await fsp.rm(`${path.resolve(file)}-wal`, { force: true });
    await fsp.rm(`${path.resolve(file)}-shm`, { force: true });
  }
}

export async function createSqliteSnapshot({ database, destination, verify = verifySqliteSnapshot }) {
  if (!database || typeof database.backup !== 'function') {
    throw new Error('SQLite backup seam with backup(destination) is required');
  }
  if (typeof verify !== 'function') throw new Error('SQLite snapshot verifier is required');
  const target = path.resolve(destination);
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  try {
    await fsp.lstat(target);
    throw new Error(`refusing to overwrite SQLite snapshot: ${target}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.part-${process.pid}-${crypto.randomUUID()}`);
  try {
    await database.backup(temporary);
    await assertRegularFile(temporary, 'SQLite backup API result');
    await verify(temporary);
    await fsp.rename(temporary, target);
    return { method: 'sqlite-backup-api', path: target, ...(await sha256File(target)) };
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}
