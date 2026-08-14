import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const outputDir = resolve(webRoot, 'public/reference-images');
const SERVER_REVISION = 'c2c903c82b13b6308f141a2eeb61a84d4dc9281e';
const RAW_ROOT = `https://raw.githubusercontent.com/sooya7/sooya/${SERVER_REVISION}/assets/references`;

const references = [
  { name: '01_main_reference_front_half.png', bytes: 2250030 },
  { name: '02_reference_full_body_standing.png', bytes: 1799840 },
  { name: '03_reference_side_profile.png', bytes: 2259178 }
];

await mkdir(outputDir, { recursive: true });
for (const reference of references) {
  const target = resolve(outputDir, reference.name);
  const existing = await readFile(target).catch(() => null);
  if (existing && validPng(existing, reference.bytes)) continue;

  const response = await fetch(`${RAW_ROOT}/${reference.name}`);
  if (!response.ok) throw new Error(`reference image download failed: ${reference.name} (${response.status})`);
  const data = Buffer.from(await response.arrayBuffer());
  if (!validPng(data, reference.bytes)) {
    throw new Error(`reference image verification failed: ${reference.name} (${data.byteLength} bytes)`);
  }
  await writeFile(target, data);
  console.log(`bundled SOOYA reference: ${reference.name}`);
}

function validPng(data, expectedBytes) {
  return data.byteLength === expectedBytes
    && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47
    && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
}
