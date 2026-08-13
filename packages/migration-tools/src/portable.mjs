import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  assertIdentifier,
  assertIsoTimestamp,
  assertNoSecrets,
  assertRegularFile,
  atomicWriteFile,
  isInside,
  isRecord,
  listRegularFiles,
  normalizeRelativePath,
  readJsonFile,
  redactSecretFields,
  resolveInside,
  sha256File,
  sha256Value,
  toPortablePath
} from './common.mjs';
import { createSqliteSnapshot, verifySqliteSnapshot } from './sqlite.mjs';

export { assertNoSecrets, createSqliteSnapshot };

export const PORTABLE_FORMAT = 'sooya-portable-migration/v1';
export const RECEIPTS_FORMAT = 'sooya-portable-import-receipts/v1';
const MANIFEST_NAME = 'migration-manifest.json';
const CHECKSUMS_NAME = 'SHA256SUMS';
const ALLOWED_ROLES = new Set(['sqlite-snapshot', 'media', 'reference', 'config', 'ombre-jsonl', 'legacy-jsonl']);

export async function exportPortablePackage(options) {
  const outputDir = path.resolve(requiredString(options?.outputDir, 'outputDir'));
  const exportId = assertIdentifier(options.exportId ?? `export-${crypto.randomUUID()}`, 'exportId');
  const createdAt = assertIsoTimestamp(options.createdAt ?? new Date().toISOString(), 'createdAt');
  const dataDir = path.resolve(requiredString(options.dataDir, 'dataDir'));
  const configDir = path.resolve(requiredString(options.configDir, 'configDir'));
  const referencesDir = options.referencesDir ? path.resolve(options.referencesDir) : null;
  const ombreSources = normalizeSourceList(options.ombreJsonl);
  const legacySources = normalizeSourceList(options.legacyJsonl);
  assertOutputOutsideSources(outputDir, [dataDir, configDir, referencesDir, ...ombreSources, ...legacySources].filter(Boolean));

  await assertAbsent(outputDir, 'portable output');
  await fsp.mkdir(path.dirname(outputDir), { recursive: true, mode: 0o700 });
  const stagingDir = path.join(path.dirname(outputDir), `.${path.basename(outputDir)}.part-${process.pid}-${crypto.randomUUID()}`);
  const roles = new Map();
  try {
    await fsp.mkdir(stagingDir, { recursive: false, mode: 0o700 });
    const snapshotRelative = 'database/sooya.db';
    const snapshotTarget = resolveInside(stagingDir, snapshotRelative);
    const snapshot = await createSqliteSnapshot({
      database: options.database,
      destination: snapshotTarget,
      verify: options.verifySnapshot ?? verifySqliteSnapshot
    });
    roles.set(snapshotRelative, 'sqlite-snapshot');

    const mediaDir = path.join(dataDir, 'media');
    await copyDirectoryPayload({
      sourceDir: mediaDir,
      destinationRoot: stagingDir,
      destinationPrefix: 'media',
      role: 'media',
      roles,
      optional: true,
      excludeTopLevel: new Set(['tmp', 'variants'])
    });
    if (referencesDir) {
      await copyDirectoryPayload({
        sourceDir: referencesDir,
        destinationRoot: stagingDir,
        destinationPrefix: 'references',
        role: 'reference',
        roles,
        optional: true
      });
    }
    await copyConfigPayload(configDir, stagingDir, roles);
    await copyJsonlSources(ombreSources, stagingDir, 'memory/ombre', 'ombre-jsonl', roles);
    await copyJsonlSources(legacySources, stagingDir, 'memory/legacy', 'legacy-jsonl', roles);

    const files = await buildFileInventory(stagingDir, roles);
    const snapshotFile = files.find((file) => file.path === snapshotRelative);
    if (!snapshotFile) throw new Error('SQLite snapshot is missing from portable inventory');
    const counts = Object.fromEntries([...ALLOWED_ROLES].map((role) => [role, files.filter((file) => file.role === role).length]));
    const manifest = {
      format: PORTABLE_FORMAT,
      exportId,
      createdAt,
      snapshot: {
        method: 'sqlite-backup-api',
        path: snapshotRelative,
        bytes: snapshotFile.bytes,
        sha256: snapshotFile.sha256
      },
      redactions: { models: true, mcp: true },
      counts,
      files
    };
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    assertNoSecrets(manifest, MANIFEST_NAME);
    await fsp.writeFile(path.join(stagingDir, MANIFEST_NAME), manifestText, { encoding: 'utf8', mode: 0o600 });
    const checksums = [
      ...files.map((file) => `${file.sha256}  ${file.path}`),
      `${sha256Value(manifestText)}  ${MANIFEST_NAME}`
    ].sort((left, right) => checksumPath(left).localeCompare(checksumPath(right), 'en'));
    await fsp.writeFile(path.join(stagingDir, CHECKSUMS_NAME), `${checksums.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    await verifyPortablePackage(stagingDir, { verifySnapshot: options.verifySnapshot ?? verifySqliteSnapshot });
    await fsp.rename(stagingDir, outputDir);
    return { outputDir, manifest, snapshot };
  } catch (error) {
    await fsp.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyPortablePackage(packageDir, options = {}) {
  const root = path.resolve(packageDir);
  const rootStat = await fsp.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('portable package must be a real directory');
  const manifestFile = path.join(root, MANIFEST_NAME);
  const checksumsFile = path.join(root, CHECKSUMS_NAME);
  await assertRegularFile(manifestFile, MANIFEST_NAME);
  await assertRegularFile(checksumsFile, CHECKSUMS_NAME);
  const { value: manifest, text: manifestText } = await readJsonFile(manifestFile, MANIFEST_NAME);
  validateManifestShape(manifest);
  assertNoSecrets(manifest, MANIFEST_NAME);

  const actualFiles = await listRegularFiles(root);
  const actualRelative = actualFiles.map((file) => file.relative).sort((left, right) => left.localeCompare(right, 'en'));
  const expectedRelative = [...manifest.files.map((file) => file.path), MANIFEST_NAME, CHECKSUMS_NAME]
    .sort((left, right) => left.localeCompare(right, 'en'));
  if (!sameArray(actualRelative, expectedRelative)) throw new Error('portable package contains missing or unlisted files');

  const expectedChecksums = new Map(manifest.files.map((file) => [file.path, file.sha256]));
  expectedChecksums.set(MANIFEST_NAME, sha256Value(manifestText));
  const checksumEntries = parseChecksums(await fsp.readFile(checksumsFile, 'utf8'));
  if (checksumEntries.size !== expectedChecksums.size) throw new Error('SHA256SUMS entry count mismatch');
  for (const [relative, expected] of expectedChecksums) {
    if (checksumEntries.get(relative) !== expected) throw new Error(`SHA256SUMS mismatch for ${relative}`);
  }

  for (const entry of manifest.files) {
    const full = resolveInside(root, entry.path, 'manifest file path');
    await assertRegularFile(full, entry.path);
    const actual = await sha256File(full);
    if (actual.sha256 !== entry.sha256) throw new Error(`checksum mismatch for ${entry.path}`);
    if (actual.bytes !== entry.bytes) throw new Error(`byte count mismatch for ${entry.path}`);
    await assertFileContainsNoSecrets(full, entry.path);
  }

  const snapshot = manifest.files.find((file) => file.path === manifest.snapshot.path);
  if (!snapshot || snapshot.role !== 'sqlite-snapshot') throw new Error('manifest snapshot file is missing');
  if (snapshot.bytes !== manifest.snapshot.bytes || snapshot.sha256 !== manifest.snapshot.sha256) {
    throw new Error('manifest snapshot metadata mismatch');
  }
  const snapshotVerifier = options.verifySnapshot === false ? null : options.verifySnapshot ?? verifySqliteSnapshot;
  if (snapshotVerifier) await snapshotVerifier(resolveInside(root, manifest.snapshot.path, 'snapshot path'));
  return { ...manifest, manifestSha256: sha256Value(manifestText), packageDir: root };
}

export async function stagePortableImport(options) {
  const packageDir = path.resolve(requiredString(options?.packageDir, 'packageDir'));
  const stagingRoot = path.resolve(requiredString(options.stagingRoot, 'stagingRoot'));
  const receiptsFile = path.resolve(requiredString(options.receiptsFile, 'receiptsFile'));
  if (typeof options.apply !== 'function') throw new Error('apply callback is required');
  const verifiedSource = await verifyPortablePackage(packageDir, { verifySnapshot: options.verifySnapshot });
  const lock = await acquireReceiptLock(receiptsFile);
  let stagedDir = null;
  let rollbackState;
  let applyStarted = false;
  try {
    const receipts = await readReceipts(receiptsFile);
    if (receipts.receipts.some((receipt) => receipt.exportId === verifiedSource.exportId)) {
      throw new Error(`duplicate exportId receipt: ${verifiedSource.exportId}`);
    }
    await fsp.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    stagedDir = resolveInside(stagingRoot, verifiedSource.exportId, 'staging exportId');
    await assertAbsent(stagedDir, 'import staging directory');
    await copyPackageToStaging(packageDir, stagedDir);
    const verified = await verifyPortablePackage(stagedDir, { verifySnapshot: options.verifySnapshot });
    const context = Object.freeze({
      packageDir,
      stagedDir,
      manifest: verified,
      manifestFile: path.join(stagedDir, MANIFEST_NAME)
    });
    rollbackState = typeof options.prepare === 'function' ? await options.prepare(context) : undefined;
    applyStarted = true;
    await options.apply(context, rollbackState);
    const receipt = {
      exportId: verified.exportId,
      manifestSha256: verified.manifestSha256,
      importedAt: options.importedAt ?? new Date().toISOString()
    };
    assertIsoTimestamp(receipt.importedAt, 'importedAt');
    receipts.receipts.push(receipt);
    receipts.receipts.sort((left, right) => left.importedAt.localeCompare(right.importedAt, 'en'));
    await atomicWriteFile(receiptsFile, `${JSON.stringify(receipts, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.rm(stagedDir, { recursive: true, force: true });
    stagedDir = null;
    return receipt;
  } catch (error) {
    let rollbackError = null;
    if (applyStarted && typeof options.rollback === 'function') {
      try {
        const manifest = verifiedSource;
        await options.rollback(Object.freeze({ packageDir, stagedDir, manifest }), rollbackState, error);
      } catch (candidate) {
        rollbackError = candidate;
      }
    }
    if (stagedDir) await fsp.rm(stagedDir, { recursive: true, force: true });
    if (rollbackError) throw new AggregateError([error, rollbackError], 'portable import failed and rollback failed');
    throw error;
  } finally {
    await lock.release();
  }
}

async function copyConfigPayload(configDir, destinationRoot, roles) {
  const files = await listRegularFiles(configDir, { optional: true });
  for (const source of files) {
    const relative = `config/${source.relative}`;
    const destination = resolveInside(destinationRoot, relative);
    await registerDestination(roles, relative, 'config');
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const basename = path.posix.basename(source.relative).toLowerCase();
    if (basename === 'models.json' || basename === 'mcp.json') {
      const { value } = await readJsonFile(source.full, source.relative);
      const redacted = redactSecretFields(value, { dropHeaders: basename === 'mcp.json' });
      assertNoSecrets(redacted, source.relative);
      await fsp.writeFile(destination, `${JSON.stringify(redacted, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    } else {
      await assertFileContainsNoSecrets(source.full, source.relative);
      await fsp.copyFile(source.full, destination, fs.constants.COPYFILE_EXCL);
    }
  }
}

async function copyDirectoryPayload({ sourceDir, destinationRoot, destinationPrefix, role, roles, optional, excludeTopLevel }) {
  const files = await listRegularFiles(sourceDir, { optional, excludeTopLevel });
  for (const source of files) {
    const relative = `${destinationPrefix}/${source.relative}`;
    await registerDestination(roles, relative, role);
    await assertFileContainsNoSecrets(source.full, source.relative);
    const destination = resolveInside(destinationRoot, relative);
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await fsp.copyFile(source.full, destination, fs.constants.COPYFILE_EXCL);
  }
}

async function copyJsonlSources(sources, destinationRoot, destinationPrefix, role, roles) {
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const stat = await fsp.lstat(source);
    if (stat.isSymbolicLink()) throw new Error(`symbolic link JSONL source is not allowed: ${source}`);
    let files;
    if (stat.isDirectory()) {
      files = await listRegularFiles(source, { filter: (relative) => relative.toLowerCase().endsWith('.jsonl') });
    } else if (stat.isFile() && source.toLowerCase().endsWith('.jsonl')) {
      files = [{ full: source, relative: path.basename(source) }];
    } else {
      throw new Error(`JSONL source must be a .jsonl file or directory: ${source}`);
    }
    for (const item of files) {
      const sourcePrefix = sources.length > 1 ? `${String(index + 1).padStart(2, '0')}-${path.basename(source)}` : '';
      const relativeTail = sourcePrefix ? `${sourcePrefix}/${item.relative}` : item.relative;
      const relative = `${destinationPrefix}/${toPortablePath(relativeTail)}`;
      await registerDestination(roles, relative, role);
      await assertJsonlContainsNoSecrets(item.full, item.relative);
      const destination = resolveInside(destinationRoot, relative);
      await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fsp.copyFile(item.full, destination, fs.constants.COPYFILE_EXCL);
    }
  }
}

async function buildFileInventory(root, roles) {
  const files = [];
  for (const [relative, role] of [...roles].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
    const full = resolveInside(root, relative);
    files.push({ path: relative, role, ...(await sha256File(full)) });
  }
  return files;
}

async function assertFileContainsNoSecrets(file, relative) {
  const extension = path.extname(relative).toLowerCase();
  if (extension === '.json') {
    const { value } = await readJsonFile(file, relative);
    assertNoSecrets(value, relative);
    return;
  }
  if (extension === '.jsonl') {
    await assertJsonlContainsNoSecrets(file, relative);
    return;
  }
  assertNoSecrets(await fsp.readFile(file), relative);
}

async function assertJsonlContainsNoSecrets(file, relative) {
  const text = await fsp.readFile(file, 'utf8');
  assertNoSecrets(text, relative);
  const lines = text.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let record;
    try {
      record = JSON.parse(lines[index]);
    } catch {
      throw new Error(`invalid JSONL in ${relative} at line ${index + 1}`);
    }
    assertNoSecrets(record, relative, `$line${index + 1}`);
  }
}

function validateManifestShape(manifest) {
  if (!isRecord(manifest) || manifest.format !== PORTABLE_FORMAT) throw new Error('unsupported portable manifest format');
  assertIdentifier(manifest.exportId, 'exportId');
  assertIsoTimestamp(manifest.createdAt, 'createdAt');
  if (!isRecord(manifest.snapshot) || manifest.snapshot.method !== 'sqlite-backup-api') {
    throw new Error('portable manifest must declare sqlite-backup-api snapshot');
  }
  normalizeRelativePath(manifest.snapshot.path, 'snapshot path');
  assertSizeAndHash(manifest.snapshot, 'snapshot');
  if (!isRecord(manifest.redactions) || manifest.redactions.models !== true || manifest.redactions.mcp !== true) {
    throw new Error('portable manifest redaction policy is missing');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('portable manifest files are missing');
  const seen = new Set();
  let previous = '';
  for (const file of manifest.files) {
    if (!isRecord(file)) throw new Error('invalid portable manifest file entry');
    normalizeRelativePath(file.path, 'manifest file path');
    if (file.path === MANIFEST_NAME || file.path === CHECKSUMS_NAME || seen.has(file.path)) throw new Error(`duplicate or reserved manifest file path: ${file.path}`);
    if (previous && previous.localeCompare(file.path, 'en') >= 0) throw new Error('portable manifest files must be sorted');
    previous = file.path;
    seen.add(file.path);
    if (!ALLOWED_ROLES.has(file.role)) throw new Error(`invalid portable file role: ${file.role}`);
    assertSizeAndHash(file, file.path);
  }
}

function assertSizeAndHash(value, label) {
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error(`invalid byte count for ${label}`);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error(`invalid SHA-256 for ${label}`);
}

function parseChecksums(text) {
  if (!text.endsWith('\n')) throw new Error('SHA256SUMS must end with a newline');
  const entries = new Map();
  let previous = '';
  for (const line of text.slice(0, -1).split('\n')) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/u.exec(line);
    if (!match) throw new Error('invalid SHA256SUMS line');
    const relative = normalizeRelativePath(match[2], 'SHA256SUMS path');
    if (entries.has(relative)) throw new Error(`duplicate SHA256SUMS path: ${relative}`);
    if (previous && previous.localeCompare(relative, 'en') >= 0) throw new Error('SHA256SUMS entries must be sorted');
    previous = relative;
    entries.set(relative, match[1]);
  }
  return entries;
}

async function readReceipts(file) {
  try {
    const { value } = await readJsonFile(file, 'import receipts');
    if (!isRecord(value) || value.format !== RECEIPTS_FORMAT || !Array.isArray(value.receipts)) {
      throw new Error('invalid import receipts document');
    }
    for (const receipt of value.receipts) {
      if (!isRecord(receipt)) throw new Error('invalid import receipt');
      assertIdentifier(receipt.exportId, 'receipt exportId');
      if (typeof receipt.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.manifestSha256)) throw new Error('invalid receipt manifest SHA-256');
      assertIsoTimestamp(receipt.importedAt, 'receipt importedAt');
    }
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT' || /^cannot read import receipts: .*ENOENT/u.test(error?.message ?? '')) {
      return { format: RECEIPTS_FORMAT, receipts: [] };
    }
    throw error;
  }
}

async function acquireReceiptLock(receiptsFile) {
  await fsp.mkdir(path.dirname(receiptsFile), { recursive: true, mode: 0o700 });
  const lockFile = `${receiptsFile}.lock`;
  let handle;
  try {
    handle = await fsp.open(lockFile, 'wx', 0o600);
    await handle.writeFile(`${process.pid}\n`);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(`import receipt lock is busy: ${lockFile}`);
    throw error;
  }
  return {
    async release() {
      await handle.close();
      await fsp.rm(lockFile, { force: true });
    }
  };
}

async function copyPackageToStaging(source, destination) {
  await fsp.mkdir(destination, { recursive: false, mode: 0o700 });
  try {
    const files = await listRegularFiles(source);
    for (const file of files) {
      const target = resolveInside(destination, file.relative);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.copyFile(file.full, target, fs.constants.COPYFILE_EXCL);
    }
  } catch (error) {
    await fsp.rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function registerDestination(roles, relative, role) {
  normalizeRelativePath(relative);
  if (roles.has(relative)) throw new Error(`portable path collision: ${relative}`);
  roles.set(relative, role);
}

async function assertAbsent(target, label) {
  try {
    await fsp.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing ${label}: ${target}`);
}

function normalizeSourceList(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((item) => path.resolve(requiredString(item, 'JSONL source')));
}

function assertOutputOutsideSources(output, sources) {
  for (const source of sources) {
    const statTarget = fs.existsSync(source) && fs.statSync(source).isFile() ? path.dirname(source) : source;
    if (isInside(statTarget, output)) throw new Error(`portable output must be outside source path: ${source}`);
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function checksumPath(line) {
  return line.slice(66);
}
