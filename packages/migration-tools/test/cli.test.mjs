import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadBetterSqlite3 } from '../src/sqlite.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const fixtureRoot = path.join(repoRoot, 'migration-fixtures', 'redacted', 'source');
const roots = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))));

function run(script, args) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', script), ...args], {
    cwd: repoRoot,
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, `${script} failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('portable and OTA CLIs execute end to end on synthetic inputs', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sooya-cli-test-'));
  roots.push(root);
  const source = path.join(root, 'source');
  await fsp.cp(fixtureRoot, source, { recursive: true });
  const dataDir = path.join(source, 'data');
  await fsp.mkdir(path.join(dataDir, 'database'), { recursive: true });
  await fsp.rename(path.join(source, 'media'), path.join(dataDir, 'media'));
  const dbFile = path.join(dataDir, 'database', 'sooya.db');
  const Database = loadBetterSqlite3();
  const db = new Database(dbFile);
  db.exec('CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO fixture(value) VALUES (\'portable\')');
  db.close();

  const portableDir = path.join(root, 'portable');
  const exported = run('export-portable.mjs', [
    '--db', dbFile,
    '--data-dir', dataDir,
    '--config-dir', path.join(source, 'config'),
    '--references-dir', path.join(source, 'references'),
    '--ombre-jsonl', path.join(source, 'ombre'),
    '--legacy-jsonl', path.join(source, 'legacy'),
    '--out', portableDir,
    '--export-id', 'export-cli-fixture'
  ]);
  assert.equal(exported.exportId, 'export-cli-fixture');
  const portableVerified = run('verify-portable.mjs', ['--package', portableDir]);
  assert.equal(portableVerified.ok, true);

  const bundleDir = path.join(root, 'bundle');
  await fsp.mkdir(bundleDir);
  await fsp.writeFile(path.join(bundleDir, 'index.html'), '<!doctype html><p>fixture</p>');
  const otaDir = path.join(root, 'ota');
  const built = run('build-ota.mjs', [
    '--bundle', bundleDir,
    '--out', otaDir,
    '--release-id', 'release-cli-fixture',
    '--native-min', '10', '--native-max', '12',
    '--schema-min', '35', '--schema-max', '36',
    '--bridge-capability', 'filesystem.v1'
  ]);
  assert.equal(built.releaseId, 'release-cli-fixture');

  const stateDir = path.join(root, 'ota-state');
  const pending = run('verify-ota.mjs', [
    '--package', otaDir,
    '--native', '11', '--schema', '36',
    '--bridge-capability', 'filesystem.v1',
    '--state-dir', stateDir,
    '--mark-pending'
  ]);
  assert.equal(pending.state.pending.releaseId, 'release-cli-fixture');
  const lastGood = run('verify-ota.mjs', [
    '--package', otaDir,
    '--native', '11', '--schema', '36',
    '--bridge-capability', 'filesystem.v1',
    '--state-dir', stateDir,
    '--mark-last-good'
  ]);
  assert.equal(lastGood.state.pending, null);
  assert.equal(lastGood.state.lastGood.releaseId, 'release-cli-fixture');
});
