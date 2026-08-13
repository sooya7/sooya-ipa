#!/usr/bin/env node
import { markOtaLastGood, markOtaPending, verifyOtaPackage, verifyOtaState } from '../packages/migration-tools/src/ota.mjs';

const usage = 'Usage: node scripts/verify-ota.mjs --package DIR [--native N --schema N --bridge-capability NAME] [--state-dir DIR] [--mark-pending|--mark-last-good]';

try {
  const args = parse(process.argv.slice(2));
  if (args.help) console.log(usage);
  else {
    if (!args.packageDir) throw new Error('missing --package');
    const hasRuntime = args.native !== undefined || args.schema !== undefined || args.bridgeCapabilities.length > 0;
    if (hasRuntime && (args.native === undefined || args.schema === undefined)) throw new Error('--native and --schema are required together');
    const runtime = hasRuntime ? {
      native: integer(args.native, '--native'),
      schema: integer(args.schema, '--schema'),
      bridgeCapabilities: args.bridgeCapabilities
    } : undefined;
    const manifest = await verifyOtaPackage(args.packageDir, { runtime });
    let state;
    if (args.markPending || args.markLastGood) {
      if (!args.stateDir) throw new Error('--state-dir is required when marking OTA state');
      if (args.markPending && args.markLastGood) throw new Error('choose one OTA state transition');
      const transition = args.markPending ? markOtaPending : markOtaLastGood;
      await transition({ stateDir: args.stateDir, packageDir: args.packageDir, runtime });
    }
    if (args.stateDir) state = await verifyOtaState({ stateDir: args.stateDir, packageDir: args.packageDir, runtime });
    console.log(JSON.stringify({ ok: true, packageDir: manifest.packageDir, releaseId: manifest.releaseId, manifestSha256: manifest.manifestSha256, ...(state ? { state } : {}) }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parse(values) {
  const output = { bridgeCapabilities: [] };
  const map = new Map([['--package', 'packageDir'], ['--native', 'native'], ['--schema', 'schema'], ['--state-dir', 'stateDir']]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--help' || value === '-h') output.help = true;
    else if (value === '--mark-pending') output.markPending = true;
    else if (value === '--mark-last-good') output.markLastGood = true;
    else if (value === '--bridge-capability') {
      const next = values[++index];
      if (!next) throw new Error('missing value for --bridge-capability');
      output.bridgeCapabilities.push(next);
    } else if (map.has(value)) {
      const next = values[++index];
      if (!next) throw new Error(`missing value for ${value}`);
      output[map.get(value)] = next;
    } else throw new Error(`unknown option: ${value}\n${usage}`);
  }
  return output;
}

function integer(value, label) { const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw new Error(`invalid ${label}`); return parsed; }

