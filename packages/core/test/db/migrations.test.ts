import { afterEach, describe, expect, it } from 'vitest';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, migrateDatabase } from '../../src/db/migrations.js';
import { NodeLocalDatabase } from './node-local-database.js';

const opened: NodeLocalDatabase[] = [];
const createDb = () => {
  const db = new NodeLocalDatabase();
  opened.push(db);
  return db;
};

afterEach(async () => {
  while (opened.length) await opened.pop()!.close();
});

describe('local schema migrations', () => {
  it('preserves schema 1-35 and appends the local migrations in order', () => {
    expect(MIGRATIONS.slice(0, 35).map((migration) => migration.version)).toEqual(
      Array.from({ length: 35 }, (_, index) => index + 1)
    );
    expect(MIGRATIONS.slice(35).map(({ version, name }) => [version, name])).toEqual([
      [36, 'local_runtime'],
      [37, 'native_mcp'],
      [38, 'secret_refs'],
      [39, 'life_clock'],
      [40, 'moment_runtime_cleanup'],
      [41, 'local_memory_provider'],
      [42, 'local_update_state'],
      [43, 'local_backup_metadata'],
      [44, 'local_provider_and_preferences']
    ]);
    expect(LATEST_SCHEMA_VERSION).toBe(44);
  });

  it('migrates a fresh database and is idempotent', async () => {
    const db = createDb();
    const now = () => '2026-08-13T02:00:00.000Z';

    await expect(migrateDatabase(db, { now })).resolves.toMatchObject({ version: 44 });
    const callsAfterFirstRun = db.transactionCalls;
    await expect(migrateDatabase(db, { now })).resolves.toMatchObject({ version: 44, applied: [] });

    const applied = await db.query<{ version: number; name: string }>('SELECT version, name FROM schema_migrations ORDER BY version');
    expect(applied).toHaveLength(44);
    expect(applied.at(-1)).toEqual({ version: 44, name: 'local_provider_and_preferences' });
    expect(db.transactionCalls).toBe(callsAfterFirstRun);
  });

  it('creates the local runtime, MCP, secret, life clock, memory, update and backup tables', async () => {
    const db = createDb();
    await migrateDatabase(db);

    const tables = await db.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'");
    const names = new Set(tables.map((row) => row.name));
    expect(names).toEqual(expect.objectContaining(new Set([
      'app_runtime',
      'migration_receipts',
      'mcp_servers',
      'mcp_tool_policies',
      'secret_refs',
      'life_clock_state',
      'local_memory_receipts',
      'local_update_state',
      'local_backup_metadata',
      'provider_configs', 'app_preferences', 'notification_capabilities'
    ])));

    const policyColumns = await db.query<{ name: string }>('PRAGMA table_info(mcp_tool_policies)');
    expect(policyColumns.map((column) => column.name)).toContain('authorized');
    const secretColumns = await db.query<{ name: string }>('PRAGMA table_info(secret_refs)');
    expect(secretColumns.map((column) => column.name)).not.toContain('value');
  });
});
