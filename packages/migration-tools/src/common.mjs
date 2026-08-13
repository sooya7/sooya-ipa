import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const SECRET_SUFFIXES = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'authorization',
  'cookie'
]);
const SECRET_KEY_PREFIXES = new Set([
  'api',
  'client',
  'private',
  'signing',
  'encryption',
  'access',
  'auth'
]);
const SAFE_SECRET_REFERENCE_SUFFIXES = new Set([
  'env',
  'envvar',
  'file',
  'path',
  'name',
  'id',
  'configured',
  'present',
  'enabled',
  'required'
]);

const CREDENTIAL_PATTERNS = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ['bearer token', /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}={0,2}\b/iu],
  ['basic credential', /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}\b/iu],
  ['JWT', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
  ['OpenAI-style key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/u],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ['Slack token', /\bxox(?:a|b|p|r|s)-[A-Za-z0-9-]{16,}\b/u],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{30,}\b/u],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u],
  ['Stripe key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/u],
  ['credential assignment', /(?:^|[?&\s"'])\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|passphrase)\b\s*(?:=|:)\s*["']?[A-Za-z0-9._~+\/-]{8,}/imu],
  ['URL userinfo', /\bhttps?:\/\/[^\s/:@]+:[^\s/@]{4,}@/iu]
];

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function fieldWords(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

export function isSecretFieldName(name) {
  const words = fieldWords(name);
  if (words.length === 0) return false;
  const last = words.at(-1);
  if (SAFE_SECRET_REFERENCE_SUFFIXES.has(last)) return false;
  if (SECRET_SUFFIXES.has(last)) return true;
  if (last === 'key') {
    return words.length === 1 || words.slice(0, -1).some((word) => SECRET_KEY_PREFIXES.has(word));
  }
  return false;
}

export function detectCredentialPattern(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  for (const [name, pattern] of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return name;
  }
  return null;
}

export function assertNoSecrets(value, source = 'value', location = '$') {
  if (typeof value === 'string' || Buffer.isBuffer(value)) {
    const pattern = detectCredentialPattern(value);
    if (pattern) throw new Error(`credential pattern ${pattern} is not allowed in ${source}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, source, `${location}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (isSecretFieldName(key)) {
        throw new Error(`secret field ${key} is not allowed in ${source} at ${location}`);
      }
      assertNoSecrets(child, source, `${location}.${key}`);
    }
    return;
  }
}

function redactUrl(raw) {
  if (!/^https?:\/\//iu.test(raw)) return raw;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  parsed.username = '';
  parsed.password = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSecretFieldName(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

export function redactSecretFields(value, options = {}) {
  if (Array.isArray(value)) return value.map((item) => redactSecretFields(item, options));
  if (!isRecord(value)) return typeof value === 'string' ? redactUrl(value) : value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretFieldName(key)) continue;
    if (options.dropHeaders === true && fieldWords(key).at(-1) === 'headers') continue;
    output[key] = redactSecretFields(child, options);
  }
  return output;
}

export function normalizeRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) {
    throw new Error(`unsafe ${label}`);
  }
  if (value !== path.posix.normalize(value) || path.posix.isAbsolute(value)) throw new Error(`unsafe ${label}: ${value}`);
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`unsafe ${label}: ${value}`);
  return value;
}

export function toPortablePath(value) {
  return value.split(path.sep).join('/');
}

export function resolveInside(root, relative, label = 'path') {
  const safe = normalizeRelativePath(relative, label);
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...safe.split('/'));
  if (target === resolvedRoot || !target.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error(`unsafe ${label}: ${relative}`);
  return target;
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  await new Promise((resolve, reject) => {
    const input = fs.createReadStream(file);
    input.on('data', (chunk) => {
      bytes += chunk.byteLength;
      hash.update(chunk);
    });
    input.on('error', reject);
    input.on('end', resolve);
  });
  return { bytes, sha256: hash.digest('hex') };
}

export function sha256Value(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export async function atomicWriteFile(file, value, options = {}) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.part-${process.pid}-${crypto.randomUUID()}`);
  try {
    await fsp.writeFile(temporary, value, { mode: options.mode ?? 0o600, encoding: options.encoding });
    await fsp.rename(temporary, file);
  } catch (error) {
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}

export async function readJsonFile(file, label = path.basename(file)) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${label}: ${safeErrorMessage(error)}`);
  }
  try {
    return { value: JSON.parse(text), text };
  } catch (error) {
    throw new Error(`invalid JSON in ${label}: ${safeErrorMessage(error)}`);
  }
}

export async function listRegularFiles(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  let rootStat;
  try {
    rootStat = await fsp.lstat(resolvedRoot);
  } catch (error) {
    if (error?.code === 'ENOENT' && options.optional === true) return [];
    throw error;
  }
  if (rootStat.isSymbolicLink()) throw new Error(`symbolic link source is not allowed: ${resolvedRoot}`);
  if (!rootStat.isDirectory()) throw new Error(`expected directory: ${resolvedRoot}`);
  const files = [];
  const visit = async (directory, relativeDirectory = '') => {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic link source is not allowed: ${full}`);
      if (entry.isDirectory()) {
        if (options.excludeTopLevel?.has(entry.name) && relativeDirectory === '') continue;
        await visit(full, relative);
      } else if (entry.isFile()) {
        if (!options.filter || options.filter(relative)) files.push({ full, relative: normalizeRelativePath(relative) });
      } else {
        throw new Error(`non-regular source entry is not allowed: ${full}`);
      }
    }
  };
  await visit(resolvedRoot);
  return files;
}

export async function assertRegularFile(file, label = file) {
  const stat = await fsp.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`expected regular file for ${label}`);
  return stat;
}

export function safeErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  let safe = raw;
  for (const [, pattern] of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    safe = safe.replace(pattern, '[REDACTED_SECRET]');
  }
  return safe.slice(0, 1000);
}

export function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(value)) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

export function assertIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`invalid ${label}`);
  return value;
}

export function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

