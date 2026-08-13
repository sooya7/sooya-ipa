#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const diffBase = process.argv[2] ?? 'origin/main...HEAD';
let diff;
try { diff = execFileSync('git', ['diff', '--unified=0', diffBase, '--', 'packages/core/src/db/migrations.ts'], { encoding: 'utf8' }); }
catch { console.warn('[ota-migration-guard] no git metadata; source checks continue without a diff'); process.exit(0); }
const added = diff.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++')).join('\n');
const destructive = /\bDROP\s+(?:TABLE|COLUMN|INDEX|TRIGGER)|\bALTER\s+TABLE[^\n]*\bRENAME\b|\bVACUUM\b|\bDELETE\s+FROM\b|\bUPDATE\s+(?!app_runtime\s+SET\b)[^\n]*\bSET\b/iu;
if (destructive.test(added)) {
  console.error('[ota-migration-guard] destructive SQL is not allowed in OTA migrations');
  console.error(added.split('\n').filter((line) => destructive.test(line)).join('\n'));
  process.exit(1);
}
console.log('[ota-migration-guard] additive migration diff accepted');
