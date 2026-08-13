import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  assertIdentifier,
  assertIsoTimestamp,
  assertRegularFile,
  atomicWriteFile,
  isRecord,
  listRegularFiles,
  normalizeRelativePath,
  readJsonFile,
  resolveInside,
  sha256File,
  sha256Value
} from './common.mjs';

export const OTA_FORMAT = 'sooya-ota/v1';
export const OTA_STATE_FORMAT = 'sooya-ota-state/v1';
const MANIFEST_NAME = 'ota-manifest.json';

export async function buildOtaPackage(options) {
  const bundleDir = path.resolve(required(options?.bundleDir, 'bundleDir'));
  const outputDir = path.resolve(required(options.outputDir, 'outputDir'));
  const releaseId = assertIdentifier(options.releaseId, 'releaseId');
  const createdAt = assertIsoTimestamp(options.createdAt ?? new Date().toISOString(), 'createdAt');
  const native = validateGate(options.native, 'native');
  const schema = validateGate(options.schema, 'schema');
  const bridgeCapabilities = validateCapabilities(options.bridgeCapabilities);
  const bundleUrl = typeof options.bundleUrl === 'string' && options.bundleUrl.trim() ? options.bundleUrl.trim() : undefined;
  if (path.relative(bundleDir, outputDir) === '' || !path.relative(bundleDir, outputDir).startsWith('..')) {
    throw new Error('OTA output must be outside bundle source');
  }
  await absent(outputDir, 'OTA output');
  const sourceFiles = await listRegularFiles(bundleDir);
  if (sourceFiles.length === 0) throw new Error('OTA bundle is empty');
  const temporary = path.join(path.dirname(outputDir), `.${path.basename(outputDir)}.part-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fsp.mkdir(path.join(temporary, 'bundle'), { recursive: true, mode: 0o700 });
    const files = [];
    for (const source of sourceFiles) {
      const relative = `bundle/${source.relative}`;
      const target = resolveInside(temporary, relative);
      await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fsp.copyFile(source.full, target, fs.constants.COPYFILE_EXCL);
      files.push({ path: relative, ...(await sha256File(target)) });
    }
    files.sort((left, right) => left.path.localeCompare(right.path, 'en'));
    const bundle = bundleIdentity(files);
    const manifest = {
      format: OTA_FORMAT,
      releaseId,
      createdAt,
      bundle,
      compatibility: { native, schema, bridgeCapabilities },
      ...(bundleUrl ? { bundleUrl } : {}),
      files
    };
    await fsp.writeFile(path.join(temporary, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await verifyOtaPackage(temporary);
    await fsp.rename(temporary, outputDir);
    return { outputDir, manifest };
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyOtaPackage(packageDir, options = {}) {
  const root = path.resolve(packageDir);
  const manifestFile = path.join(root, MANIFEST_NAME);
  await assertRegularFile(manifestFile, MANIFEST_NAME);
  const { value: manifest, text } = await readJsonFile(manifestFile, MANIFEST_NAME);
  validateOtaManifest(manifest);
  const actualFiles = await listRegularFiles(root);
  const actual = actualFiles.map((file) => file.relative).sort((left, right) => left.localeCompare(right, 'en'));
  const expected = [...manifest.files.map((file) => file.path), MANIFEST_NAME].sort((left, right) => left.localeCompare(right, 'en'));
  if (!same(actual, expected)) throw new Error('OTA package contains missing or unlisted files');
  for (const entry of manifest.files) {
    const result = await sha256File(resolveInside(root, entry.path, 'OTA file path'));
    if (result.sha256 !== entry.sha256) throw new Error(`checksum mismatch for ${entry.path}`);
    if (result.bytes !== entry.bytes) throw new Error(`byte count mismatch for ${entry.path}`);
  }
  const identity = bundleIdentity(manifest.files);
  if (identity.sha256 !== manifest.bundle.sha256) throw new Error('OTA bundle SHA mismatch');
  if (identity.bytes !== manifest.bundle.bytes) throw new Error('OTA bundle byte count mismatch');
  if (identity.fileCount !== manifest.bundle.fileCount) throw new Error('OTA bundle file count mismatch');
  if (options.runtime) assertRuntimeCompatible(manifest, options.runtime);
  return { ...manifest, manifestSha256: sha256Value(text), packageDir: root };
}

export function assertRuntimeCompatible(manifest, runtime) {
  if (!Number.isSafeInteger(runtime?.native)) throw new Error('runtime native version is required');
  if (!Number.isSafeInteger(runtime?.schema)) throw new Error('runtime schema version is required');
  const capabilities = new Set(validateCapabilities(runtime.bridgeCapabilities));
  const compatibility = manifest.compatibility;
  if (runtime.native < compatibility.native.min || runtime.native > compatibility.native.max) {
    throw new Error(`native version gate rejected ${runtime.native}`);
  }
  if (runtime.schema < compatibility.schema.min || runtime.schema > compatibility.schema.max) {
    throw new Error(`schema version gate rejected ${runtime.schema}`);
  }
  const missing = compatibility.bridgeCapabilities.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) throw new Error(`missing bridge capability: ${missing.join(', ')}`);
  return true;
}

export async function markOtaPending(options) {
  const entry = await makeStateEntry(options, 'pending');
  const stateDir = path.resolve(required(options.stateDir, 'stateDir'));
  await atomicWriteFile(path.join(stateDir, 'pending.json'), `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8' });
  return entry;
}

export async function markOtaLastGood(options) {
  const entry = await makeStateEntry(options, 'last-good');
  const stateDir = path.resolve(required(options.stateDir, 'stateDir'));
  await atomicWriteFile(path.join(stateDir, 'last-good.json'), `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8' });
  await fsp.rm(path.join(stateDir, 'pending.json'), { force: true });
  return entry;
}

export async function verifyOtaState(options) {
  const stateDir = path.resolve(required(options?.stateDir, 'stateDir'));
  const verified = await verifyOtaPackage(options.packageDir, { runtime: options.runtime });
  const pending = await readOptionalState(path.join(stateDir, 'pending.json'), 'pending');
  const lastGood = await readOptionalState(path.join(stateDir, 'last-good.json'), 'last-good');
  for (const state of [pending, lastGood].filter(Boolean)) {
    if (state.releaseId !== verified.releaseId) throw new Error(`${state.state} releaseId does not match OTA package`);
    if (state.manifestSha256 !== verified.manifestSha256) throw new Error(`${state.state} manifest SHA does not match OTA package`);
    if (state.bundleSha256 !== verified.bundle.sha256) throw new Error(`${state.state} bundle SHA does not match OTA package`);
  }
  return { pending, lastGood };
}

async function makeStateEntry(options, state) {
  const verified = await verifyOtaPackage(required(options.packageDir, 'packageDir'), { runtime: options.runtime });
  return {
    format: OTA_STATE_FORMAT,
    state,
    releaseId: verified.releaseId,
    manifestSha256: verified.manifestSha256,
    bundleSha256: verified.bundle.sha256,
    recordedAt: assertIsoTimestamp(options.recordedAt ?? new Date().toISOString(), 'recordedAt')
  };
}

async function readOptionalState(file, expectedState) {
  try {
    const { value } = await readJsonFile(file, `${expectedState} OTA state`);
    if (!isRecord(value) || value.format !== OTA_STATE_FORMAT || value.state !== expectedState) throw new Error(`invalid ${expectedState} OTA state`);
    assertIdentifier(value.releaseId, 'state releaseId');
    if (!/^[a-f0-9]{64}$/u.test(value.manifestSha256 ?? '')) throw new Error(`invalid ${expectedState} manifest SHA`);
    if (!/^[a-f0-9]{64}$/u.test(value.bundleSha256 ?? '')) throw new Error(`invalid ${expectedState} bundle SHA`);
    assertIsoTimestamp(value.recordedAt, 'state recordedAt');
    return value;
  } catch (error) {
    if (error?.code === 'ENOENT' || /^cannot read .*ENOENT/u.test(error?.message ?? '')) return null;
    throw error;
  }
}

function validateOtaManifest(manifest) {
  if (!isRecord(manifest) || manifest.format !== OTA_FORMAT) throw new Error('unsupported OTA manifest format');
  assertIdentifier(manifest.releaseId, 'releaseId');
  assertIsoTimestamp(manifest.createdAt, 'createdAt');
  if (!isRecord(manifest.compatibility)) throw new Error('OTA compatibility gates are missing');
  validateGate(manifest.compatibility.native, 'native');
  validateGate(manifest.compatibility.schema, 'schema');
  validateCapabilities(manifest.compatibility.bridgeCapabilities);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('OTA file list is missing');
  let previous = '';
  const seen = new Set();
  for (const file of manifest.files) {
    if (!isRecord(file)) throw new Error('invalid OTA file entry');
    normalizeRelativePath(file.path, 'OTA file path');
    if (!file.path.startsWith('bundle/') || seen.has(file.path)) throw new Error(`invalid OTA file path: ${file.path}`);
    if (previous && previous.localeCompare(file.path, 'en') >= 0) throw new Error('OTA files must be sorted');
    seen.add(file.path);
    previous = file.path;
    validateFileIdentity(file, file.path);
  }
  if (!isRecord(manifest.bundle)) throw new Error('OTA bundle identity is missing');
  validateFileIdentity(manifest.bundle, 'bundle');
  if (!Number.isSafeInteger(manifest.bundle.fileCount) || manifest.bundle.fileCount < 1) throw new Error('invalid OTA bundle file count');
}

function validateFileIdentity(value, label) {
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0) throw new Error(`invalid bytes for ${label}`);
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) throw new Error(`invalid SHA-256 for ${label}`);
}

function bundleIdentity(files) {
  const canonical = files.map((file) => `${file.sha256} ${file.bytes} ${file.path}\n`).join('');
  return {
    sha256: sha256Value(canonical),
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    fileCount: files.length
  };
}

function validateGate(value, label) {
  if (!isRecord(value) || !Number.isSafeInteger(value.min) || !Number.isSafeInteger(value.max) || value.min < 0 || value.max < value.min) {
    throw new Error(`invalid ${label} compatibility gate`);
  }
  return { min: value.min, max: value.max };
}

function validateCapabilities(value) {
  if (!Array.isArray(value)) throw new Error('bridge capabilities must be an array');
  const unique = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u.test(item)) throw new Error(`invalid bridge capability: ${item}`);
    if (unique.has(item)) throw new Error(`duplicate bridge capability: ${item}`);
    unique.add(item);
  }
  return [...unique].sort((left, right) => left.localeCompare(right, 'en'));
}

async function absent(target, label) {
  try {
    await fsp.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`refusing to overwrite existing ${label}: ${target}`);
}

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

function same(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
