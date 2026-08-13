import type { HttpPlatform, HttpRequest } from '../platform/http.js';
import type { BinaryData } from './types.js';
import { ProviderRequestError } from './types.js';

export interface SecretHeader {
  ref?: string | null;
  header?: string;
  prefix?: string;
}

export async function requestJson<T>(
  http: HttpPlatform,
  input: Omit<HttpRequest, 'body'> & { body?: unknown },
  secret: SecretHeader = {}
): Promise<T> {
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  const response = await http.request({
    ...input,
    body,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(input.headers ?? {}) },
    ...(secret.ref ? { secretRef: secret.ref, secretHeader: secret.header ?? 'Authorization', secretPrefix: secret.prefix ?? 'Bearer ' } : {})
  });
  const text = new TextDecoder().decode(response.body);
  let value: unknown = null;
  if (text.trim()) {
    try { value = JSON.parse(text); } catch { value = text; }
  }
  if (response.status < 200 || response.status >= 300) {
    const record = isRecord(value) ? value : {};
    const message = typeof record.error === 'string'
      ? record.error
      : typeof record.message === 'string' ? record.message : `provider request failed (${response.status})`;
    throw new ProviderRequestError(message.slice(0, 500), response.status);
  }
  return value as T;
}

/** Request a binary provider response without trying to parse it as JSON. */
export async function requestBytes(
  http: HttpPlatform,
  input: Omit<HttpRequest, 'body'> & { body?: unknown },
  secret: SecretHeader = {}
): Promise<{ body: Uint8Array; mime: string }> {
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  const response = await http.request({
    ...input,
    body,
    headers: { Accept: '*/*', 'Content-Type': 'application/json', ...(input.headers ?? {}) },
    ...(secret.ref ? { secretRef: secret.ref, secretHeader: secret.header ?? 'Authorization', secretPrefix: secret.prefix ?? 'Bearer ' } : {})
  });
  if (response.status < 200 || response.status >= 300) {
    const text = new TextDecoder().decode(response.body);
    let message = `provider request failed (${response.status})`;
    try {
      const value = JSON.parse(text) as unknown;
      if (isRecord(value)) {
        if (typeof value.error === 'string') message = value.error;
        else if (typeof value.message === 'string') message = value.message;
      }
    } catch { /* preserve the generic status message for non-JSON errors */ }
    throw new ProviderRequestError(message.slice(0, 500), response.status);
  }
  return { body: response.body, mime: response.headers['content-type'] ?? 'application/octet-stream' };
}

export function toBase64(value: BinaryData): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let output = '';
  for (let index = 0; index < bytes.length; index += 0x8000) output += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(output);
}

export function binaryBytes(value: unknown, fallbackMime = 'application/octet-stream'): { data: Uint8Array; mime: string } {
  if (typeof value === 'string') {
    const match = value.match(/^data:([^;,]+)?;base64,(.*)$/u);
    if (match) return { data: fromBase64(match[2]!), mime: match[1] ?? fallbackMime };
    return { data: new TextEncoder().encode(value), mime: fallbackMime };
  }
  if (isRecord(value) && typeof value.b64_json === 'string') return { data: fromBase64(value.b64_json), mime: fallbackMime };
  throw new ProviderRequestError('provider returned no binary data');
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function endpoint(baseUrl: string, suffix: string): string {
  const base = baseUrl.trim().replace(/\/+$/u, '');
  if (base.endsWith(suffix)) return base;
  if (suffix.startsWith('/v1/') && base.endsWith('/v1')) return `${base}${suffix.slice(3)}`;
  return `${base}${suffix}`;
}

export function healthStatus(capability: string, provider: string, configured: boolean, model: string, detail?: string) {
  return { capability, configured, ok: configured && !detail, provider, model, detail, checkedAt: new Date().toISOString() };
}
