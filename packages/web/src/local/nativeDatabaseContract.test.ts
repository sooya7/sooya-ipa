import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { databaseTransactionCallOptions } from './nativeBoot.js';

describe('SOOYADatabase transaction bridge contract', () => {
  it('uses the statements field consumed by the Swift plugin', () => {
    expect(databaseTransactionCallOptions([
      { type: 'run', sql: 'INSERT INTO t(v) VALUES (?)', values: ['x'] }
    ])).toEqual({
      statements: [{ type: 'run', sql: 'INSERT INTO t(v) VALUES (?)', values: ['x'] }]
    });
    const swift = readFileSync(path.resolve('../../ios/App/App/Plugins/SOOYADatabasePlugin.swift'), 'utf8');
    expect(swift).toContain('call.getArray("statements")');
  });
});
