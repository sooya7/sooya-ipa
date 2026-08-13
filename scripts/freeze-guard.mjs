#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const nativePaths = [/^ios\/.*\.(swift|m|mm|h|plist|entitlements|pbxproj)$/u, /^capacitor\.config\.ts$/u, /^scripts\/patch-xcode-project\.mjs$/u];
const baseVersion = 'ios/App/App/native-base.version';
const diffBase = process.argv[2] ?? 'origin/main...HEAD';
try {
  execFileSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' });
} catch {
  console.warn('[freeze-guard] no git metadata in this workspace; source checks continue without a diff');
  process.exit(0);
}
let changed;
try {
  changed = execFileSync('git', ['diff', '--name-only', diffBase], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
} catch {
  changed = execFileSync('git', ['diff', '--name-only', 'HEAD~1'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
}
const nativeChanged = changed.filter((file) => nativePaths.some((pattern) => pattern.test(file)));
if (nativeChanged.length > 0 && !changed.includes(baseVersion)) {
  console.error(`Native Base is frozen; bump ${baseVersion} in the same change before editing native files.`);
  console.error(nativeChanged.join('\n'));
  process.exit(1);
}
if (!fs.existsSync(baseVersion)) {
  console.error(`Missing ${baseVersion}`);
  process.exit(1);
}
const version = fs.readFileSync(baseVersion, 'utf8').trim();
if (!/^\d+$/u.test(version)) {
  console.error(`${baseVersion} must contain a numeric native bridge version`);
  process.exit(1);
}
console.log(`[freeze-guard] native base ${version}; ${nativeChanged.length} native file(s) changed`);
