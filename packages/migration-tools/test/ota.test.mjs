import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';

import {
  buildOtaPackage,
  markOtaLastGood,
  markOtaPending,
  verifyOtaPackage,
  verifyOtaState
} from '../src/ota.mjs';

const roots = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sooya-ota-test-'));
  roots.push(root);
  const bundleDir = path.join(root, 'bundle');
  await fsp.mkdir(path.join(bundleDir, 'assets'), { recursive: true });
  await fsp.writeFile(path.join(bundleDir, 'index.html'), '<!doctype html><script src="assets/app.js"></script>');
  await fsp.writeFile(path.join(bundleDir, 'assets', 'app.js'), 'globalThis.SOOYA_FIXTURE=true;');
  return { root, bundleDir, outputDir: path.join(root, 'ota') };
}

test('OTA build records sha, bytes and compatibility gates and verifies matching runtime', async () => {
  const { bundleDir, outputDir } = await fixture();
  const built = await buildOtaPackage({
    bundleDir,
    outputDir,
    releaseId: 'release-fixture-0001',
    createdAt: '2026-08-13T00:00:00.000Z',
    native: { min: 12, max: 14 },
    schema: { min: 35, max: 36 },
    bridgeCapabilities: ['filesystem.v1', 'sqlite.backup.v1']
  });
  assert.equal(built.manifest.releaseId, 'release-fixture-0001');
  assert.match(built.manifest.bundle.sha256, /^[a-f0-9]{64}$/);
  assert.ok(built.manifest.bundle.bytes > 0);

  const verified = await verifyOtaPackage(outputDir, {
    runtime: { native: 13, schema: 36, bridgeCapabilities: ['sqlite.backup.v1', 'filesystem.v1', 'camera.v1'] }
  });
  assert.equal(verified.releaseId, 'release-fixture-0001');
  await assert.rejects(
    verifyOtaPackage(outputDir, {
      runtime: { native: 11, schema: 36, bridgeCapabilities: ['filesystem.v1', 'sqlite.backup.v1'] }
    }),
    /native.*gate/i
  );
  await assert.rejects(
    verifyOtaPackage(outputDir, {
      runtime: { native: 13, schema: 37, bridgeCapabilities: ['filesystem.v1'] }
    }),
    /schema.*gate|missing bridge capability/i
  );
});

test('OTA verification rejects bundle tampering', async () => {
  const { bundleDir, outputDir } = await fixture();
  await buildOtaPackage({
    bundleDir,
    outputDir,
    releaseId: 'release-fixture-0002',
    native: { min: 1, max: 1 },
    schema: { min: 1, max: 1 },
    bridgeCapabilities: []
  });
  await fsp.appendFile(path.join(outputDir, 'bundle', 'index.html'), 'tampered');
  await assert.rejects(verifyOtaPackage(outputDir), /checksum mismatch/i);
});

test('pending and last-good metadata bind to a verified OTA manifest', async () => {
  const { root, bundleDir, outputDir } = await fixture();
  await buildOtaPackage({
    bundleDir,
    outputDir,
    releaseId: 'release-fixture-0003',
    native: { min: 2, max: 4 },
    schema: { min: 7, max: 8 },
    bridgeCapabilities: ['filesystem.v1']
  });
  const stateDir = path.join(root, 'state');
  await markOtaPending({ stateDir, packageDir: outputDir, recordedAt: '2026-08-13T00:01:00.000Z' });
  let state = await verifyOtaState({ stateDir, packageDir: outputDir });
  assert.equal(state.pending.releaseId, 'release-fixture-0003');
  assert.equal(state.lastGood, null);

  await markOtaLastGood({ stateDir, packageDir: outputDir, recordedAt: '2026-08-13T00:02:00.000Z' });
  state = await verifyOtaState({ stateDir, packageDir: outputDir });
  assert.equal(state.pending.releaseId, undefined);
  assert.equal(state.pending, null);
  assert.equal(state.lastGood.releaseId, 'release-fixture-0003');
  await fsp.writeFile(path.join(stateDir, 'last-good.json'), JSON.stringify({ ...state.lastGood, manifestSha256: '0'.repeat(64) }));
  await assert.rejects(verifyOtaState({ stateDir, packageDir: outputDir }), /manifest sha/i);
});

test('signs and verifies the canonical OTA manifest payload', async () => {
  const { bundleDir, outputDir } = await fixture();
  const keys = crypto.generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const built = await buildOtaPackage({
    bundleDir, outputDir, releaseId: 'release-fixture-sign-1',
    native: { min: 1, max: 1 }, schema: { min: 45, max: 45 }, bridgeCapabilities: [], signingPrivateKey: privateKey
  });
  assert.equal(built.manifest.signature.algorithm, 'ed25519');
  assert.equal((await verifyOtaPackage(outputDir, { requireSignature: true })).releaseId, 'release-fixture-sign-1');
  const manifestPath = path.join(outputDir, 'ota-manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  manifest.releaseId = 'tampered-release';
  await fsp.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyOtaPackage(outputDir, { requireSignature: true }), /checksum|signature/i);
});

test('signed OTA pins an external HTTPS bundle URL while allowing a separately verified zip checksum', async () => {
  const { bundleDir, outputDir } = await fixture();
  const keys = crypto.generateKeyPairSync('ed25519');
  const privateKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const bundleUrl = 'https://github.com/sooya7/sooya-ipa/releases/download/ota-bundle-fixture/bundle.zip';
  await buildOtaPackage({
    bundleDir,
    outputDir,
    releaseId: 'release-fixture-public-url',
    createdAt: '2026-08-14T00:00:00.000Z',
    bundleUrl,
    native: { min: 10, max: 10 },
    schema: { min: 46, max: 46 },
    bridgeCapabilities: ['ota.updater'],
    signingPrivateKey: privateKey
  });

  const manifestPath = path.join(outputDir, 'ota-manifest.json');
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf8'));
  assert.equal(manifest.bundleUrl, bundleUrl);
  manifest.bundle.zipSha256 = 'a'.repeat(64);
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.equal((await verifyOtaPackage(outputDir, { requireSignature: true })).bundleUrl, bundleUrl);

  manifest.bundleUrl = 'https://example.invalid/replaced.zip';
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(verifyOtaPackage(outputDir, { requireSignature: true }), /signature/i);
});
