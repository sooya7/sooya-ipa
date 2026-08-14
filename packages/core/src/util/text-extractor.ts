/**
 * Pure-TS media text extraction. Core is a zero-Node-dependency package (see
 * test/boundary.test.ts), so this deliberately does NOT use node:zlib /
 * node:fs. PDF text is extracted from the literal text layer of both
 * uncompressed and FlateDecode content streams (via the in-repo pure-TS
 * inflate implementation); docx/zip is read by walking the zip local file
 * headers and inflating word/document.xml.
 */

import { inflatePdf, inflateRaw } from './inflate.js';

export type TextExtractionResult =
  | { status: 'ready'; text: string; metadata: { chars: number; truncated: boolean } }
  | { status: 'unsupported'; metadata: { reason: string } }
  | { status: 'failed'; error: string; metadata: { reason: string } };

const MAX_EXTRACTED_CHARS = 80_000;
/** Per-stream inflate cap: larger streams are skipped, not decompressed. */
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
/** Upper bound on the number of PDF streams inspected. */
const MAX_PDF_STREAMS = 200;
/** Upper bound on zip local headers scanned. */
const MAX_ZIP_ENTRIES = 512;

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
    return extractDocx(data);
  }
  if (normalizedMime === 'application/zip' || extension === 'zip') {
    return extractZipText(data);
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

/** Bounded PDF text-layer extraction. Handles literal strings in Tj/TJ
 * operators from uncompressed content streams AND FlateDecode streams (the
 * common case for real-world PDFs), inflating each stream with the pure-TS
 * inflate. Malformed streams are skipped rather than failing the file. */
function extractPdfText(data: Uint8Array): TextExtractionResult {
  if (!startsWithAscii(data, '%PDF-')) return { status: 'failed', error: 'invalid_pdf', metadata: { reason: 'invalid_pdf' } };
  const source = latin1Decode(data);
  const pieces: string[] = [];
  collectPdfLiterals(source, pieces);
  // FlateDecode streams: inflate and run the same literal pass on each.
  const streamRe = /stream\r?\n/gu;
  let scanned = 0;
  let match: RegExpExecArray | null;
  while (scanned < MAX_PDF_STREAMS && (match = streamRe.exec(source)) !== null) {
    scanned += 1;
    const dictStart = Math.max(0, match.index - 4096);
    if (!/\/FlateDecode/u.test(source.slice(dictStart, match.index))) continue;
    const start = streamRe.lastIndex;
    const end = source.indexOf('endstream', start);
    if (end < 0) break;
    if (end - start > MAX_STREAM_BYTES) continue;
    const rawBytes = latin1ToBytes(source.slice(start, end).replace(/[\r\n]+$/u, ''));
    if (rawBytes.length === 0) continue;
    try {
      collectPdfLiterals(latin1Decode(inflatePdf(rawBytes)), pieces);
    } catch {
      // Malformed stream: skip it; other streams may still yield text.
    }
  }
  const text = pieces.join(' ').trim();
  if (!text) return { status: 'unsupported', metadata: { reason: 'no_text_layer_or_compressed' } };
  const chars = [...text];
  const truncated = chars.length > MAX_EXTRACTED_CHARS;
  return { status: 'ready', text: chars.slice(0, MAX_EXTRACTED_CHARS).join(''), metadata: { chars: Math.min(chars.length, MAX_EXTRACTED_CHARS), truncated } };
}

function collectPdfLiterals(source: string, pieces: string[]): void {
  const literal = /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*T[Jj]/gu;
  let guard = 0;
  for (const match of source.matchAll(literal)) {
    if (++guard > 10_000) break;
    pieces.push(decodePdfLiteral(match[1]!));
  }
}

function decodePdfLiteral(value: string): string {
  return value.replace(/\\([\\()])/gu, '$1').replace(/\\n/gu, '\n').replace(/\\r/gu, '\r').replace(/\\t/gu, '\t');
}

/** Extracts the text of a .docx by reading word/document.xml from the zip
 * container (pure-TS zip walk + raw inflate). */
function extractDocx(data: Uint8Array): TextExtractionResult {
  try {
    const xml = extractZipEntry(data, 'word/document.xml');
    if (!xml) return { status: 'unsupported', metadata: { reason: 'docx_missing_document_xml' } };
    return xmlToText(xml);
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'docx_failed', metadata: { reason: 'docx_read_failed' } };
  }
}

/** Best-effort text extraction from a generic zip: the first readable text
 * entry wins (README, index.txt, ...). */
function extractZipText(data: Uint8Array): TextExtractionResult {
  try {
    const entries: string[] = [];
    let seen = 0;
    for (const entry of walkZipEntries(data)) {
      if (++seen > MAX_ZIP_ENTRIES) break;
      if (!entry.name.endsWith('.txt') && !entry.name.endsWith('.md') && !entry.name.endsWith('.csv')) continue;
      const decoded = tryUtf8(entry.data);
      if (decoded !== null && decoded.trim()) entries.push(decoded);
    }
    const text = entries.join('\n').trim();
    if (!text) return { status: 'unsupported', metadata: { reason: 'zip_no_text_entry' } };
    const chars = [...text];
    const truncated = chars.length > MAX_EXTRACTED_CHARS;
    return { status: 'ready', text: chars.slice(0, MAX_EXTRACTED_CHARS).join(''), metadata: { chars: Math.min(chars.length, MAX_EXTRACTED_CHARS), truncated } };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'zip_failed', metadata: { reason: 'zip_read_failed' } };
  }
}

interface ZipEntry { name: string; data: Uint8Array; }

/** Walks zip local file headers (stored + deflate entries) until the central
 * directory begins; supports the entries real-world .docx/.zip files carry. */
function walkZipEntries(data: Uint8Array): Array<ZipEntry> {
  if (data.length < 4) throw new Error('zip: too short');
  if (data[0] !== 0x50 || data[1] !== 0x4b || data[2] !== 0x03 || data[3] !== 0x04) throw new Error('zip: bad signature');
  if (data.length < 30) throw new Error('zip: truncated header');
  const entries: ZipEntry[] = [];
  let pos = 0;
  for (let guard = 0; guard < MAX_ZIP_ENTRIES; guard += 1) {
    if (pos + 30 > data.length) break;
    if (data[pos] !== 0x50 || data[pos + 1] !== 0x4b) break;
    const sig = data[pos + 2]! | (data[pos + 3]! << 8);
    if (sig === 0x0201) break; // central directory starts here
    if (sig !== 0x0403) break; // not a local header (EOCD or garbage)
    const method = data[pos + 8]! | (data[pos + 9]! << 8);
    const compSize = readU32(data, pos + 18);
    const nameLen = readU16(data, pos + 26);
    const extraLen = readU16(data, pos + 28);
    const nameStart = pos + 30;
    if (nameStart + nameLen > data.length) throw new Error('zip: truncated name');
    const name = tryUtf8(data.subarray(nameStart, nameStart + nameLen)) ?? latin1Decode(data.subarray(nameStart, nameStart + nameLen));
    const bodyStart = nameStart + nameLen + extraLen;
    if (bodyStart + compSize > data.length) throw new Error('zip: truncated entry');
    const compressed = data.subarray(bodyStart, bodyStart + compSize);
    if (method === 0) {
      entries.push({ name, data: Uint8Array.from(compressed) });
    } else if (method === 8) {
      entries.push({ name, data: inflateRaw(compressed) });
    }
    // Unknown methods are skipped; the file may still yield other entries.
    pos = bodyStart + compSize;
    if (compSize === 0 && nameLen === 0 && extraLen === 0) break; // no progress guard
  }
  return entries;
}

function extractZipEntry(data: Uint8Array, wanted: string): Uint8Array | null {
  for (const entry of walkZipEntries(data)) {
    if (entry.name === wanted || entry.name.endsWith(wanted)) return entry.data;
  }
  return null;
}

/** Converts document.xml into plain text: tags stripped, paragraph breaks kept. */
function xmlToText(xml: Uint8Array): TextExtractionResult {
  try {
    const source = utf8Decode(xml);
    const withBreaks = source
      .replace(/<\/w:p>/gu, '\n')
      .replace(/<w:tab\s*\/>/gu, '\t')
      .replace(/<w:br\s*\/>/gu, '\n');
    const stripped = withBreaks.replace(/<[^>]+>/gu, '').replace(/[\r\n]+/gu, '\n');
    const text = decodeXmlEntities(stripped).replace(/[ \t]+\n/gu, '\n').trim();
    if (!text) return { status: 'ready', text: '', metadata: { chars: 0, truncated: false } };
    const chars = [...text];
    const truncated = chars.length > MAX_EXTRACTED_CHARS;
    return { status: 'ready', text: chars.slice(0, MAX_EXTRACTED_CHARS).join(''), metadata: { chars: Math.min(chars.length, MAX_EXTRACTED_CHARS), truncated } };
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : 'xml_decode_failed', metadata: { reason: 'xml_decode_failed' } };
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&apos;/gu, "'").replace(/&amp;/gu, '&')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/gu, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function startsWithAscii(data: Uint8Array, prefix: string): boolean {
  if (data.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (data[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}

function readU16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function readU32(data: Uint8Array, offset: number): number {
  return (data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16) | (data[offset + 3]! << 24)) >>> 0;
}

function tryUtf8(data: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
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

function latin1ToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index) & 0xff;
  return bytes;
}
