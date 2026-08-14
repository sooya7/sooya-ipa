/**
 * Pure-TS media text extraction. Core is a zero-Node-dependency package, so
 * this deliberately does NOT use node:zlib / node:fs. PDF text is extracted
 * from the literal text layer with a bounded regex; docx/zip would need an
 * inflate implementation and are reported unsupported (the native Swift
 * archive plugin covers unpacking where needed).
 */

export type TextExtractionResult =
  | { status: 'ready'; text: string; metadata: { chars: number; truncated: boolean } }
  | { status: 'unsupported'; metadata: { reason: string } }
  | { status: 'failed'; error: string; metadata: { reason: string } };

const MAX_EXTRACTED_CHARS = 80_000;

const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/javascript', 'text/typescript',
  'text/css', 'text/html', 'text/xml', 'application/json', 'application/javascript', 'application/typescript',
  'application/xml', 'application/x-yaml', 'application/toml'
]);

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'html', 'htm',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'env', 'sql', 'sh', 'bash', 'py', 'java', 'go', 'rs', 'vue', 'svelte',
  'kt', 'swift', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'lua'
]);

export function extractText(data: Uint8Array, mime: string, filename?: string): TextExtractionResult {
  const normalizedMime = mime.split(';', 1)[0]!.trim().toLowerCase();
  const extension = filename?.split('.').pop()?.toLowerCase() ?? '';
  if (normalizedMime === 'application/pdf' || extension === 'pdf') return extractPdfText(data);
  if (normalizedMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || extension === 'docx') {
    return { status: 'unsupported', metadata: { reason: 'docx_requires_inflate' } };
  }
  if (normalizedMime === 'application/zip' || extension === 'zip') {
    return { status: 'unsupported', metadata: { reason: 'zip_requires_inflate' } };
  }
  if (!TEXT_MIMES.has(normalizedMime) && !TEXT_EXTENSIONS.has(extension)) {
    return { status: 'unsupported', metadata: { reason: 'format_not_supported' } };
  }
  if (data.includes(0)) return { status: 'unsupported', metadata: { reason: 'binary_content' } };
  try {
    const raw = utf8Decode(data).replace(/^\uFEFF/u, '');
    const chars = [...raw];
    const truncated = chars.length > MAX_EXTRACTED_CHARS;
    const text = chars.slice(0, MAX_EXTRACTED_CHARS).join('');
    if (!text.trim()) return { status: 'ready', text: '', metadata: { chars: 0, truncated: false } };
    return { status: 'ready', text, metadata: { chars: text.length, truncated } };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'text_decode_failed', metadata: { reason: 'decode_failed' } };
  }
}

/** Bounded PDF text-layer extraction. Handles uncompressed literal strings in
 * Tj/TJ operators; compressed streams are reported unsupported rather than
 * risking a hang on malformed input. */
function extractPdfText(data: Uint8Array): TextExtractionResult {
  if (!startsWithAscii(data, '%PDF-')) return { status: 'failed', error: 'invalid_pdf', metadata: { reason: 'invalid_pdf' } };
  // Flate streams start with 0x78 and are common; we cannot inflate in pure
  // TS, so only extract from uncompressed content streams.
  const source = latin1Decode(data);
  const pieces: string[] = [];
  const literal = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*T[Jj]/gu;
  let guard = 0;
  for (const match of source.matchAll(literal)) {
    if (++guard > 10_000) break;
    pieces.push(decodePdfLiteral(match[1]!));
  }
  const text = pieces.join(' ').trim();
  if (!text) return { status: 'unsupported', metadata: { reason: 'no_text_layer_or_compressed' } };
  const chars = [...text];
  const truncated = chars.length > MAX_EXTRACTED_CHARS;
  return { status: 'ready', text: chars.slice(0, MAX_EXTRACTED_CHARS).join(''), metadata: { chars: Math.min(chars.length, MAX_EXTRACTED_CHARS), truncated } };
}

function decodePdfLiteral(value: string): string {
  return value.replace(/\\([\\()])/gu, '$1').replace(/\\n/gu, '\n').replace(/\\r/gu, '\r').replace(/\\t/gu, '\t');
}

function startsWithAscii(data: Uint8Array, prefix: string): boolean {
  if (data.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

function utf8Decode(data: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new Error('invalid_utf8');
  }
}

function latin1Decode(data: Uint8Array): string {
  let output = '';
  for (let index = 0; index < data.length; index += 0x8000) {
    output += String.fromCharCode(...data.subarray(index, index + 0x8000));
  }
  return output;
}
