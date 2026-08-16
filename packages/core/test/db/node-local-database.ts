import { createRequire } from 'node:module';
import { existsSync, rmSync, statSync } from 'node:fs';

interface NativeRunResult { changes: number; lastInsertRowid: number | bigint; }
interface NativeStatement {
  run(...values: TestDbValue[]): NativeRunResult;
  all(...values: TestDbValue[]): unknown[];
}
interface NativeDatabase {
  pragma(source: string): unknown;
  exec(sql: string): void;
  prepare(sql: string): NativeStatement;
  transaction<T extends unknown[], R>(operation: (...args: T) => R): (...args: T) => R;
  close(): void;
  backup(target: string): Promise<unknown>;
}

const coreRequire = createRequire(new URL('../../package.json', import.meta.url));
const Database = coreRequire('better-sqlite3') as new (filename: string) => NativeDatabase;

export type TestDbValue = string | number | null | Uint8Array;

export interface TestDbOperation {
  type: 'execute' | 'run' | 'query';
  sql: string;
  values?: TestDbValue[];
}

/**
 * CI-only async seam for the native LocalDatabase contract.
 * Production Core never imports this module or better-sqlite3.
 */
export class NodeLocalDatabase {
  readonly raw: NativeDatabase;
  transactionCalls = 0;
  transactionHistory: TestDbOperation[][] = [];

  constructor(filename = ':memory:') {
    this.raw = new Database(filename);
    this.raw.pragma('foreign_keys = ON');
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('synchronous = NORMAL');
    this.raw.pragma('busy_timeout = 8000');
    this.raw.pragma('temp_store = MEMORY');
  }

  async open(): Promise<void> {}

  async close(): Promise<void> {
    this.raw.close();
  }

  async execute(sql: string): Promise<void> {
    this.raw.exec(sql);
  }

  async run(sql: string, values: TestDbValue[] = []): Promise<{ changes: number; lastInsertRowid?: number }> {
    const result = this.raw.prepare(sql).run(...values);
    return {
      changes: result.changes,
      ...(typeof result.lastInsertRowid === 'bigint'
        ? { lastInsertRowid: Number(result.lastInsertRowid) }
        : { lastInsertRowid: result.lastInsertRowid })
    };
  }

  async query<T>(sql: string, values: TestDbValue[] = []): Promise<T[]> {
    return this.raw.prepare(sql).all(...values) as T[];
  }

  async transaction<T = unknown[]>(operations: TestDbOperation[]): Promise<T> {
    this.transactionCalls += 1;
    this.transactionHistory.push(structuredClone(operations));
    const execute = this.raw.transaction((batch: TestDbOperation[]) => batch.map((operation) => {
      if (operation.type === 'execute') {
        this.raw.exec(operation.sql);
        return undefined;
      }
      if (operation.type === 'query') return this.raw.prepare(operation.sql).all(...(operation.values ?? []));
      const result = this.raw.prepare(operation.sql).run(...(operation.values ?? []));
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
    }));
    return execute(operations) as T;
  }

  async integrityCheck(): Promise<{ ok: boolean; integrity: string[]; foreignKeys: unknown[] }> {
    const integrity = this.raw.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const foreignKeys = this.raw.pragma('foreign_key_check') as unknown[];
    return { ok: integrity.every((row) => row.integrity_check === 'ok') && foreignKeys.length === 0, integrity: integrity.map((row) => row.integrity_check), foreignKeys };
  }

  async backup(target: string): Promise<void> {
    await this.raw.backup(target);
  }

  async verifyBackup(target: string): Promise<{ fileName: string; sizeBytes: number; verified: boolean }> {
    if (!existsSync(target)) throw new Error('backup not found');
    const check = new Database(target);
    try {
      const integrity = check.pragma('integrity_check') as Array<{ integrity_check: string }>;
      return { fileName: target, sizeBytes: statSync(target).size, verified: integrity.every((row) => row.integrity_check === 'ok') };
    } finally {
      check.close();
    }
  }

  async deleteBackup(target: string): Promise<boolean> {
    try {
      rmSync(target, { force: true });
      return true;
    } catch {
      return false;
    }
  }
}

