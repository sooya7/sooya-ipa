import type { BinaryData } from '../providers/types.js';

export type DatabaseValue = string | number | bigint | boolean | null | BinaryData;
export type DatabaseParameters = readonly DatabaseValue[] | Readonly<Record<string, DatabaseValue>>;
export type DatabaseRow = Record<string, unknown>;

/** Low-level values supported by native SQLite adapters. */
export type DbValue = string | number | bigint | boolean | null | BinaryData;

export type DbOperation =
  | { type: 'execute'; sql: string }
  | { type: 'run' | 'query'; sql: string; values?: DbValue[] };

export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface DatabaseIntegrityResult {
  ok: boolean;
  integrity: string[];
  foreignKeys: unknown[];
}

/** Async native-database port shared by Node test and Capacitor adapters. */
export interface LocalDatabase {
  open(): Promise<void>;
  close(): Promise<void>;
  execute(sql: string): Promise<void>;
  run(sql: string, values?: DbValue[]): Promise<RunResult>;
  query<Row = Record<string, unknown>>(sql: string, values?: DbValue[]): Promise<Row[]>;
  transaction<T = unknown[]>(operations: DbOperation[]): Promise<T>;
  integrityCheck(): Promise<DatabaseIntegrityResult>;
  backup(target: string): Promise<void>;
}

export interface DatabaseRunResult {
  changes: number;
  lastInsertId?: string | number | bigint;
}

export interface DatabasePlatform {
  execute(sql: string, parameters?: DatabaseParameters): Promise<DatabaseRunResult>;
  query<Row extends DatabaseRow = DatabaseRow>(sql: string, parameters?: DatabaseParameters): Promise<Row[]>;
  queryOne<Row extends DatabaseRow = DatabaseRow>(sql: string, parameters?: DatabaseParameters): Promise<Row | undefined>;
  transaction<T>(operation: (database: DatabasePlatform) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DatabaseAdapter = DatabasePlatform;
