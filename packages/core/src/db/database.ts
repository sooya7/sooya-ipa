import type { DbOperation, DbValue, LocalDatabase, RunResult } from '../platform/database.js';

export type { DbOperation, DbValue, LocalDatabase, RunResult };

export async function queryOne<T>(db: LocalDatabase, sql: string, values: DbValue[] = []): Promise<T | undefined> {
  const rows = await db.query<T>(sql, values);
  return rows[0];
}

export function executeOperation(sql: string): DbOperation {
  return { type: 'execute', sql } as DbOperation;
}

export function runOperation(sql: string, values: DbValue[] = []): DbOperation {
  return { type: 'run', sql, values } as DbOperation;
}

export function queryOperation(sql: string, values: DbValue[] = []): DbOperation {
  return { type: 'query', sql, values } as DbOperation;
}

export async function runTransaction<T = unknown[]>(db: LocalDatabase, operations: DbOperation[]): Promise<T> {
  return await db.transaction<T>(operations);
}

export function changes(result: unknown): number {
  return typeof result === 'object' && result !== null && typeof (result as RunResult).changes === 'number'
    ? (result as RunResult).changes
    : 0;
}

export function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

export function placeholders(length: number): string {
  return Array.from({ length }, () => '?').join(',');
}

export function newId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random.replace(/-/gu, '')}`;
}

export function nowIso(now: () => Date = () => new Date()): string {
  return now().toISOString();
}

export function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
