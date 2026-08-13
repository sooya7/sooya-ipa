#!/usr/bin/env node
import { exportPortablePackage } from '../packages/migration-tools/src/portable.mjs';
import { openSqliteBackupSource, verifySqliteSnapshot } from '../packages/migration-tools/src/sqlite.mjs';

const usage = 'Usage: node scripts/export-portable.mjs --db FILE --data-dir DIR --config-dir DIR --out DIR [--references-dir DIR] [--ombre-jsonl PATH] [--legacy-jsonl PATH] [--export-id ID]';

try {
  const args = parse(process.argv.slice(2));
  if (args.help) {
    console.log(usage);
  } else {
    for (const key of ['db', 'dataDir', 'configDir', 'out']) if (!args[key]) throw new Error(`missing --${hyphen(key)}`);
    const database = openSqliteBackupSource(args.db);
    try {
      const result = await exportPortablePackage({
        database,
        verifySnapshot: verifySqliteSnapshot,
        outputDir: args.out,
        exportId: args.exportId,
        createdAt: args.createdAt,
        dataDir: args.dataDir,
        configDir: args.configDir,
        referencesDir: args.referencesDir,
        ombreJsonl: args.ombreJsonl,
        legacyJsonl: args.legacyJsonl
      });
      console.log(JSON.stringify({ ok: true, outputDir: result.outputDir, exportId: result.manifest.exportId, manifest: result.manifest }, null, 2));
    } finally {
      database.close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parse(values) {
  const output = { ombreJsonl: [], legacyJsonl: [] };
  const map = new Map([
    ['--db', 'db'], ['--data-dir', 'dataDir'], ['--config-dir', 'configDir'], ['--out', 'out'],
    ['--references-dir', 'referencesDir'], ['--export-id', 'exportId'], ['--created-at', 'createdAt']
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--help' || value === '-h') output.help = true;
    else if (value === '--ombre-jsonl' || value === '--legacy-jsonl') {
      const next = values[++index];
      if (!next) throw new Error(`missing value for ${value}`);
      output[value === '--ombre-jsonl' ? 'ombreJsonl' : 'legacyJsonl'].push(next);
    } else if (map.has(value)) {
      const next = values[++index];
      if (!next) throw new Error(`missing value for ${value}`);
      output[map.get(value)] = next;
    } else throw new Error(`unknown option: ${value}\n${usage}`);
  }
  return output;
}

function hyphen(value) { return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`); }
