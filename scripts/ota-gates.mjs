#!/usr/bin/env node
/**
 * Single source of truth for OTA compatibility gates.
 *
 * ota.yml used to hard-code --native-min/max, --schema-min/max and the 15
 * bridge-capability names, duplicating what Swift (SOOYAReleaseConfig) and
 * core (migrations.ts) already declare. This script derives the gates from
 * those sources so a native/schema/capability change cannot silently desync
 * the OTA gate. Usage:
 *
 *   node scripts/ota-gates.mjs            # print JSON to stdout
 *   node scripts/ota-gates.mjs --env      # print KEY=VALUE lines for CI
 *
 * Exits non-zero when the Swift capabilities fail the shared format check
 * (the same validation migration-tools/ota.mjs applies at build time).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCapabilities } from '../packages/migration-tools/src/ota.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_CONFIG = path.join(ROOT, 'ios/App/App/Plugins/SOOYAReleaseConfig.swift');
const MIGRATIONS = path.join(ROOT, 'packages/core/src/db/migrations.ts');

function fail(message) {
  console.error(`[ota-gates] ${message}`);
  process.exit(1);
}

const swift = fs.readFileSync(RELEASE_CONFIG, 'utf8');
const nativeMatch = /static\s+let\s+nativeBaseVersion\s*=\s*(\d+)/u.exec(swift);
const bridgeMatch = /static\s+let\s+bridgeVersion\s*=\s*(\d+)/u.exec(swift);
const capabilitiesMatch = /static\s+let\s+capabilities\s*=\s*\[([\s\S]*?)\]/u.exec(swift);
if (!nativeMatch) fail(`cannot find nativeBaseVersion in ${RELEASE_CONFIG}`);
if (!bridgeMatch) fail(`cannot find bridgeVersion in ${RELEASE_CONFIG}`);
if (!capabilitiesMatch) fail(`cannot find capabilities array in ${RELEASE_CONFIG}`);

const capabilities = [...capabilitiesMatch[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
if (capabilities.length === 0) fail('capabilities array is empty');

const migrations = fs.readFileSync(MIGRATIONS, 'utf8');
// LATEST_SCHEMA_VERSION is derived from the last MIGRATIONS entry; parse the
// trailing `{ version: N, name: '...' }` declarations instead of the const.
const versionMatches = [...migrations.matchAll(/\{\s*version:\s*(\d+)\s*,\s*name:/gu)].map((match) => Number(match[1]));
const latestSchema = versionMatches.length > 0 ? Math.max(...versionMatches) : null;
if (!latestSchema) fail(`cannot find any migration version in ${MIGRATIONS}`);

const gates = {
  nativeMin: Number(nativeMatch[1]),
  nativeMax: Number(nativeMatch[1]),
  bridgeVersion: Number(bridgeMatch[1]),
  schemaMin: latestSchema,
  schemaMax: latestSchema,
  bridgeCapabilities: validateCapabilities(capabilities)
};

if (process.argv.includes('--env')) {
  console.log(`NATIVE_MIN=${gates.nativeMin}`);
  console.log(`NATIVE_MAX=${gates.nativeMax}`);
  console.log(`BRIDGE_VERSION=${gates.bridgeVersion}`);
  console.log(`SCHEMA_MIN=${gates.schemaMin}`);
  console.log(`SCHEMA_MAX=${gates.schemaMax}`);
  // Quoted so `source` keeps the space-separated list in one variable.
  console.log(`OTA_CAPABILITIES="${gates.bridgeCapabilities.join(' ')}"`);
} else {
  console.log(JSON.stringify(gates, null, 2));
}
