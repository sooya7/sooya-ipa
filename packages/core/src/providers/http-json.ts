import type { HttpPlatform, HttpRequest, HttpResponseHead } from '../platform/http.js';
import type { BinaryData } from './types.js';
import { ProviderRequestError } from './types.js';

export interface SecretHeader {
  ref?: string | null;
  header?: string;
  prefix?: string;
}

export interface SseEvent {
  event?: string;
  id?: string;
  data: string;
  retry?: number;
}

export interface SseResponse {
  head: HttpResponseHead;
  /** Retained only as a bounded fallback for providers that ignore stream=true. */
  rawBody: Uint8Array;
  eventCount: number;
}

/**
 * Consume an SSE response without putting provider-specific protocol rules in
 * the native bridge. Native HTTP may deliver arbitrary byte chunks; the
 * parser handles UTF-8 boundaries, CRLF/LF and multi-line data fields.
 */
export async function requestSse(
  http: HttpPlatform,
  input: Omit<HttpRequest, 'body'> & { body?: unknown },
  onEvent: (event: SseEvent) => void,
  secret: SecretHeader = {}
): Promise<SseResponse> {
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  const parser = new SseParser(onEvent);
  const raw: Uint8Array[] = [];
  let rawBytes = 0;
  const head = await http.stream({
    ...input,
    body,
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json', ...(input.headers ?? {}) },
    ...(secret.ref ? { secretRef: secret.ref, secretHeader: secret.header ?? 'Authorization', secretPrefix: secret.prefix ?? 'Bearer ' } : {})
  }, (chunk) => {
    if (rawBytes < 4 * 1024 * 1024) {
      const bounded = chunk.subarray(0, Math.max(0, 4 * 1024 * 1024 - rawBytes));
      raw.push(bounded);
      rawBytes += bounded.byteLength;
    }
    parser.consume(chunk);
  });
  parser.finish();
  const rawBody = concatBytes(raw, rawBytes);
  if (head.status < 200 || head.status >= 300) throw providerStatusError(head.status, rawBody);
  return { head, rawBody, eventCount: parser.eventCount };
}

class SseParser {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private eventName: string | undefined;
  private eventId: string | undefined;
  private retry: number | undefined;
  private data: string[] = [];
  eventCount = 0;

  constructor(private readonly emit: (event: SseEvent) => void) {}

  consume(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drain(false);
  }

  finish(): void {
    this.buffer += this.decoder.decode();
    this.drain(true);
    this.dispatch();
  }

  private drain(final: boolean): void {
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.parseLine(line);
    }
    if (final && this.buffer) {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = '';
      this.parseLine(line);
    }
  }

  private parseLine(line: string): void {
    if (line === '') { this.dispatch(); return; }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /u, '');
    if (field === 'event') this.eventName = value;
    else if (field === 'id') this.eventId = value;
    else if (field === 'retry') {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed >= 0) this.retry = parsed;
    } else if (field === 'data') this.data.push(value);
  }

  private dispatch(): void {
    if (this.data.length === 0) { this.eventName = undefined; this.eventId = undefined; this.retry = undefined; return; }
    this.emit({ event: this.eventName, id: this.eventId, retry: this.retry, data: this.data.join('\n') });
    this.eventCount += 1;
    this.eventName = undefined;
    this.eventId = undefined;
    this.retry = undefined;
    this.data = [];
  }
}

function concatBytes(chunks: Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

function providerStatusError(status: number, body: Uint8Array): ProviderRequestError {
  const text = new TextDecoder().decode(body);
  let message = `provider request failed (${status})`;
  try {
    const value = JSON.parse(text) as unknown;
    if (isRecord(value)) {
      if (typeof value.error === 'string') message = value.error;
      else if (isRecord(value.error) && typeof value.error.message === 'string') message = value.error.message;
      else if (typeof value.message === 'string') message = value.message;
    }
  } catch { /* retain status */ }
  return new ProviderRequestError(message.slice(0, 500), status);
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
    // OpenAI-style endpoints wrap the reason as {error:{message}}; extract it
    // so downstream classifiers (e.g. the JSON-mode downgrade) can see it.
    const nestedError = isRecord(record.error) ? record.error : {};
    const message = typeof record.error === 'string'
      ? record.error
      : typeof nestedError.message === 'string'
        ? nestedError.message
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
