#!/usr/bin/env node
import { verifyPortablePackage } from '../packages/migration-tools/src/portable.mjs';

try {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/verify-portable.mjs --package DIR');
  } else {
    const index = args.indexOf('--package');
    if (index < 0 || !args[index + 1]) throw new Error('missing --package');
    if (args.length !== 2) throw new Error(`unknown option: ${args.find((value, position) => position !== index && position !== index + 1)}`);
    const manifest = await verifyPortablePackage(args[index + 1]);
    console.log(JSON.stringify({ ok: true, packageDir: manifest.packageDir, exportId: manifest.exportId, manifestSha256: manifest.manifestSha256, files: manifest.files.length }, null, 2));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
