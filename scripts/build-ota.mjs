#!/usr/bin/env node
import { buildOtaPackage } from '../packages/migration-tools/src/ota.mjs';

const usage = 'Usage: node scripts/build-ota.mjs --bundle DIR --out DIR --release-id ID --native-min N --native-max N --schema-min N --schema-max N [--bundle-url URL] [--bridge-capability NAME]';

try {
  const args = parse(process.argv.slice(2));
  if (args.help) console.log(usage);
  else {
    for (const key of ['bundle', 'out', 'releaseId', 'nativeMin', 'nativeMax', 'schemaMin', 'schemaMax']) if (args[key] === undefined) throw new Error(`missing --${hyphen(key)}`);
    const result = await buildOtaPackage({
      bundleDir: args.bundle,
      outputDir: args.out,
      releaseId: args.releaseId,
      bundleUrl: args.bundleUrl,
      createdAt: args.createdAt,
      native: { min: integer(args.nativeMin, '--native-min'), max: integer(args.nativeMax, '--native-max') },
      schema: { min: integer(args.schemaMin, '--schema-min'), max: integer(args.schemaMax, '--schema-max') },
      bridgeCapabilities: args.bridgeCapabilities
    });
    console.log(JSON.stringify({ ok: true, outputDir: result.outputDir, releaseId: result.manifest.releaseId, manifest: result.manifest }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parse(values) {
  const output = { bridgeCapabilities: [] };
  const map = new Map([
    ['--bundle', 'bundle'], ['--out', 'out'], ['--release-id', 'releaseId'], ['--bundle-url', 'bundleUrl'], ['--created-at', 'createdAt'],
    ['--native-min', 'nativeMin'], ['--native-max', 'nativeMax'], ['--schema-min', 'schemaMin'], ['--schema-max', 'schemaMax']
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === '--help' || value === '-h') output.help = true;
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
function hyphen(value) { return value.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`); }
