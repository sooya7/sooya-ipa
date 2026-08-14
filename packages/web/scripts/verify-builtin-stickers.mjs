import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsRoot = path.join(root, 'public', 'builtin-stickers');
const manifest = JSON.parse(await readFile(path.join(root, 'src', 'local', 'builtin-stickers.json'), 'utf8'));
if (!Array.isArray(manifest) || manifest.length !== 244) throw new Error(`expected 244 built-in stickers, got ${manifest?.length ?? 'invalid manifest'}`);
const expectedSnapshotSha256 = '1527a1e05b342093f22d7610c65a032d094f7c96b7542c27216905800203a588';
// Recursive canonical JSON keeps nested tag arrays and object fields stable.
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const canonicalSnapshotSha256 = createHash('sha256').update(canonical(manifest)).digest('hex');
if (canonicalSnapshotSha256 !== expectedSnapshotSha256) throw new Error(`server sticker snapshot mismatch: ${canonicalSnapshotSha256}`);

const files = new Set(await readdir(assetsRoot));
let totalBytes = 0;
for (const seed of manifest) {
  const filename = path.basename(seed.assetPath);
  if (!files.delete(filename)) throw new Error(`missing built-in sticker: ${filename}`);
  const bytes = await readFile(path.join(assetsRoot, filename));
  if (bytes.byteLength !== seed.bytes) throw new Error(`size mismatch: ${filename}`);
  if (createHash('sha256').update(bytes).digest('hex') !== seed.sha256) throw new Error(`sha256 mismatch: ${filename}`);
  totalBytes += bytes.byteLength;
}
if (files.size > 0) throw new Error(`unexpected built-in stickers: ${[...files].slice(0, 5).join(', ')}`);
console.log(`[builtin-stickers] verified ${manifest.length} server assets, ${totalBytes} bytes, snapshot ${canonicalSnapshotSha256}`);
