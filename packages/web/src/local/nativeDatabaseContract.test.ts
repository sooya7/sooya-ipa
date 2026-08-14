import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CapacitorDatabase, databaseTransactionCallOptions } from './nativeBoot.js';

describe('SOOYADatabase bridge contract', () => {
  it('preserves operation types and encodes binary/int64 values for Swift', () => {
    const options = databaseTransactionCallOptions([
      { type: 'execute', sql: 'CREATE TABLE t(v BLOB)' },
      { type: 'run', sql: 'INSERT INTO t(v) VALUES (?)', values: [new Uint8Array([1, 2]), 9_007_199_254_740_993n] },
      { type: 'query', sql: 'SELECT v FROM t' }
    ]);
    expect(options.statements.map((value) => value.type)).toEqual(['execute', 'run', 'query']);
    expect(options.statements[1]?.values).toEqual([
      { type: 'blob', base64: 'AQI=' },
      { type: 'int64', value: '9007199254740993' }
    ]);
  });

  it('Swift transaction dispatches execute/run/query instead of treating every statement as run', () => {
    const swift = readFileSync(path.resolve('../../ios/App/App/Plugins/SOOYADatabasePlugin.swift'), 'utf8');
    expect(swift).toContain('let type = object["type"] as? String ?? "run"');
    expect(swift).toContain('case "execute":');
    expect(swift).toContain('case "query":');
    expect(swift).toContain('sqlite3_exec(connection, statement.sql');
  });

  it('query envelope and row values are normalized by the web adapter', async () => {
    const database = Object.create(CapacitorDatabase.prototype) as unknown as CapacitorDatabase;
    Object.defineProperty(database, 'plugin', { value: {
      call: async () => ({ rows: [{ id: { type: 'int64', value: '9007199254740993' }, payload: { type: 'blob', base64: 'AQI=' } }] })
    }});
    const rows = await database.query<{ id: bigint; payload: Uint8Array }>('SELECT id,payload FROM t');
    expect(rows[0]?.id).toBe(9_007_199_254_740_993n);
    expect(Array.from(rows[0]?.payload ?? [])).toEqual([1, 2]);
  });
});
