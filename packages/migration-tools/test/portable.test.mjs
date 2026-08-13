import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PORTABLE_FORMAT,
  assertNoSecrets,
  createSqliteSnapshot,
  exportPortablePackage,
  stagePortableImport,
  verifyPortablePackage
} from '../src/portable.mjs';
import { loadBetterSqlite3, openSqliteBackupSource, verifySqliteSnapshot } from '../src/sqlite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixtureRoot = path.join(repoRoot, 'migration-fixtures', 'redacted', 'source');
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

async function temporaryRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sooya-portable-test-'));
  temporaryRoots.push(root);
  return root;
}

async function prepareSource(root) {
  const source = path.join(root, 'source');
  await fsp.cp(fixtureRoot, source, { recursive: true });
  const dataDir = path.join(source, 'data');
  await fsp.mkdir(path.join(dataDir, 'database'), { recursive: true });
  await fsp.rename(path.join(source, 'media'), path.join(dataDir, 'media'));
  return {
    source,
    dataDir,
    configDir: path.join(source, 'config'),
    referencesDir: path.join(source, 'references'),
    ombre: [path.join(source, 'ombre')],
    legacy: [path.join(source, 'legacy')],
    dbFile: path.join(dataDir, 'database', 'sooya.db')
  };
}

test('createSqliteSnapshot delegates to the injected SQLite backup seam', async () => {
  const root = await temporaryRoot();
  const destination = path.join(root, 'snapshot', 'sooya.db');
  const calls = [];
  const database = {
    async backup(target) {
      calls.push(target);
      await fsp.writeFile(target, 'sqlite-backup-api-result');
      return { totalPages: 1, remainingPages: 0 };
    }
  };

  const record = await createSqliteSnapshot({
    database,
    destination,
    verify: async (candidate) => assert.equal(await fsp.readFile(candidate, 'utf8'), 'sqlite-backup-api-result')
  });

  assert.equal(calls.length, 1);
  assert.match(path.basename(calls[0]), /^\.sooya\.db\.part-/);
  assert.equal(await fsp.readFile(destination, 'utf8'), 'sqlite-backup-api-result');
  assert.equal(record.bytes, Buffer.byteLength('sqlite-backup-api-result'));
  assert.match(record.sha256, /^[a-f0-9]{64}$/);
});

test('portable export captures a live WAL database and all migration payload classes', async () => {
  const root = await temporaryRoot();
  const paths = await prepareSource(root);
  const Database = loadBetterSqlite3();
  const writer = new Database(paths.dbFile);
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  writer.prepare('INSERT INTO messages(id, body) VALUES (?, ?)').run('m1', 'committed while WAL is live');
  assert.equal(fs.existsSync(`${paths.dbFile}-wal`), true);

  const models = JSON.parse(await fsp.readFile(path.join(paths.configDir, 'models.json'), 'utf8'));
  models.chat.apiKey = `sk-${'fixtureonly'.repeat(4)}`;
  await fsp.writeFile(path.join(paths.configDir, 'models.json'), JSON.stringify(models));
  const mcp = JSON.parse(await fsp.readFile(path.join(paths.configDir, 'mcp.json'), 'utf8'));
  mcp.servers.ombre.headers = { Authorization: `Bearer ${'fixtureonly'.repeat(4)}` };
  await fsp.writeFile(path.join(paths.configDir, 'mcp.json'), JSON.stringify(mcp));

  const backupSource = openSqliteBackupSource(paths.dbFile);
  const outputDir = path.join(root, 'portable');
  try {
    const result = await exportPortablePackage({
      outputDir,
      exportId: 'export-fixture-0001',
      createdAt: '2026-08-13T00:00:00.000Z',
      database: backupSource,
      verifySnapshot: verifySqliteSnapshot,
      dataDir: paths.dataDir,
      configDir: paths.configDir,
      referencesDir: paths.referencesDir,
      ombreJsonl: paths.ombre,
      legacyJsonl: paths.legacy
    });
    assert.equal(result.manifest.format, PORTABLE_FORMAT);
  } finally {
    backupSource.close();
    writer.close();
  }

  const verified = await verifyPortablePackage(outputDir);
  assert.equal(verified.exportId, 'export-fixture-0001');
  assert.equal(verified.snapshot.method, 'sqlite-backup-api');
  assert.deepEqual(new Set(verified.files.map((file) => file.role)), new Set([
    'sqlite-snapshot', 'media', 'reference', 'config', 'ombre-jsonl', 'legacy-jsonl'
  ]));

  const snapshot = new Database(path.join(outputDir, 'database', 'sooya.db'), { readonly: true });
  try {
    assert.deepEqual(snapshot.prepare('SELECT id, body FROM messages').get(), {
      id: 'm1', body: 'committed while WAL is live'
    });
  } finally {
    snapshot.close();
  }

  const portableModels = JSON.parse(await fsp.readFile(path.join(outputDir, 'config', 'models.json'), 'utf8'));
  const portableMcp = JSON.parse(await fsp.readFile(path.join(outputDir, 'config', 'mcp.json'), 'utf8'));
  assert.equal('apiKey' in portableModels.chat, false);
  assert.equal('headers' in portableMcp.servers.ombre, false);
  assert.equal((await fsp.readFile(path.join(outputDir, 'SHA256SUMS'), 'utf8')).includes('migration-manifest.json'), true);
});

test('secret-shaped fields and common credential shapes are blocked', async () => {
  assert.throws(
    () => assertNoSecrets({ nested: { accessToken: 'plain-fixture-value' } }, 'fixture.json'),
    /secret field.*accessToken/i
  );
  assert.throws(
    () => assertNoSecrets(`authorization: Bearer ${'fixtureonly'.repeat(4)}`, 'fixture.txt'),
    /credential pattern/i
  );

  const root = await temporaryRoot();
  const paths = await prepareSource(root);
  await fsp.writeFile(
    path.join(paths.configDir, 'persona.json'),
    JSON.stringify({ name: 'fixture', refresh_token: 'plain-fixture-value' })
  );
  const database = {
    async backup(target) {
      await fsp.writeFile(target, 'synthetic sqlite bytes');
    }
  };
  await assert.rejects(
    exportPortablePackage({
      outputDir: path.join(root, 'blocked'),
      exportId: 'export-fixture-0002',
      database,
      verifySnapshot: async () => {},
      dataDir: paths.dataDir,
      configDir: paths.configDir,
      referencesDir: paths.referencesDir,
      ombreJsonl: paths.ombre,
      legacyJsonl: paths.legacy
    }),
    /secret field.*refresh_token/i
  );
  assert.equal(fs.existsSync(path.join(root, 'blocked')), false);
});

test('portable verification rejects checksum tampering', async () => {
  const root = await temporaryRoot();
  const paths = await prepareSource(root);
  const database = {
    async backup(target) {
      await fsp.writeFile(target, 'synthetic sqlite bytes');
    }
  };
  const outputDir = path.join(root, 'portable');
  await exportPortablePackage({
    outputDir,
    exportId: 'export-fixture-0003',
    database,
    verifySnapshot: async () => {},
    dataDir: paths.dataDir,
    configDir: paths.configDir,
    referencesDir: paths.referencesDir,
    ombreJsonl: paths.ombre,
    legacyJsonl: paths.legacy
  });
  await fsp.appendFile(path.join(outputDir, 'media', 'images', 'fixture.txt'), 'tampered');
  await assert.rejects(verifyPortablePackage(outputDir), /checksum mismatch/i);
});

test('staged import rolls back failures and rejects a completed exportId receipt', async () => {
  const root = await temporaryRoot();
  const paths = await prepareSource(root);
  const outputDir = path.join(root, 'portable');
  await exportPortablePackage({
    outputDir,
    exportId: 'export-fixture-0004',
    database: { async backup(target) { await fsp.writeFile(target, 'synthetic sqlite bytes'); } },
    verifySnapshot: async () => {},
    dataDir: paths.dataDir,
    configDir: paths.configDir,
    referencesDir: paths.referencesDir,
    ombreJsonl: paths.ombre,
    legacyJsonl: paths.legacy
  });

  const stagingRoot = path.join(root, 'staging');
  const receiptsFile = path.join(root, 'state', 'receipts.json');
  const events = [];
  await assert.rejects(
    stagePortableImport({
      packageDir: outputDir,
      stagingRoot,
      receiptsFile,
      verifySnapshot: false,
      prepare: async (context) => {
        events.push(`prepare:${context.manifest.exportId}`);
        return { previous: 'last-good' };
      },
      apply: async () => {
        events.push('apply');
        throw new Error('synthetic apply failure');
      },
      rollback: async (_context, rollbackState, error) => {
        events.push(`rollback:${rollbackState.previous}:${error.message}`);
      }
    }),
    /synthetic apply failure/
  );
  assert.deepEqual(events, [
    'prepare:export-fixture-0004',
    'apply',
    'rollback:last-good:synthetic apply failure'
  ]);
  assert.equal(fs.existsSync(path.join(stagingRoot, 'export-fixture-0004')), false);
  assert.equal(fs.existsSync(receiptsFile), false);

  let applyCount = 0;
  await stagePortableImport({
    packageDir: outputDir,
    stagingRoot,
    receiptsFile,
    verifySnapshot: false,
    apply: async () => { applyCount += 1; }
  });
  await assert.rejects(
    stagePortableImport({
      packageDir: outputDir,
      stagingRoot,
      receiptsFile,
      verifySnapshot: false,
      apply: async () => { applyCount += 1; }
    }),
    /duplicate exportId receipt/i
  );
  assert.equal(applyCount, 1);
  const receipts = JSON.parse(await fsp.readFile(receiptsFile, 'utf8'));
  assert.equal(receipts.receipts[0].exportId, 'export-fixture-0004');
  assert.match(receipts.receipts[0].manifestSha256, /^[a-f0-9]{64}$/);
});

test('portable verifier rejects a validly checksummed package containing a token shape', async () => {
  const root = await temporaryRoot();
  const packageDir = path.join(root, 'crafted');
  await fsp.mkdir(path.join(packageDir, 'config'), { recursive: true });
  await fsp.mkdir(path.join(packageDir, 'database'), { recursive: true });
  const payload = `Bearer ${'fixtureonly'.repeat(4)}\n`;
  const relative = 'config/unsafe.txt';
  const databaseRelative = 'database/sooya.db';
  const databasePayload = 'synthetic sqlite bytes';
  await fsp.writeFile(path.join(packageDir, relative), payload);
  await fsp.writeFile(path.join(packageDir, databaseRelative), databasePayload);
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  const databaseHash = crypto.createHash('sha256').update(databasePayload).digest('hex');
  const manifest = {
    format: PORTABLE_FORMAT,
    exportId: 'export-fixture-0005',
    createdAt: '2026-08-13T00:00:00.000Z',
    snapshot: {
      method: 'sqlite-backup-api',
      path: databaseRelative,
      bytes: Buffer.byteLength(databasePayload),
      sha256: databaseHash
    },
    redactions: { models: true, mcp: true },
    files: [
      { path: relative, role: 'config', bytes: Buffer.byteLength(payload), sha256: payloadHash },
      { path: databaseRelative, role: 'sqlite-snapshot', bytes: Buffer.byteLength(databasePayload), sha256: databaseHash }
    ]
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  await fsp.writeFile(path.join(packageDir, 'migration-manifest.json'), manifestText);
  const manifestHash = crypto.createHash('sha256').update(manifestText).digest('hex');
  await fsp.writeFile(path.join(packageDir, 'SHA256SUMS'), `${payloadHash}  ${relative}\n${databaseHash}  ${databaseRelative}\n${manifestHash}  migration-manifest.json\n`);

  await assert.rejects(verifyPortablePackage(packageDir, { verifySnapshot: false }), /credential pattern/i);
});

