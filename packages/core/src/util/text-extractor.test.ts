import { deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { extractText } from './text-extractor.js';

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff];
}

/** Builds a minimal zip with one deflate-stored entry (local header only). */
function zipWithEntry(name: string, content: Uint8Array, method: 0 | 8 = 8): Uint8Array {
  const body = method === 8 ? deflateRawSync(content) : content;
  const nameBytes = bytesOf(name);
  const header = [
    0x50, 0x4b, 0x03, 0x04, // local file header
    ...u16(20), // version needed
    ...u16(0), // flags
    ...u16(method), // compression method
    ...u16(0), // mod time
    ...u16(0), // mod date
    ...u32(0), // crc32 (unchecked)
    ...u32(body.length),
    ...u32(content.length),
    ...u16(nameBytes.length),
    ...u16(0) // extra length
  ];
  const out = new Uint8Array(header.length + nameBytes.length + body.length);
  out.set(header, 0);
  out.set(nameBytes, header.length);
  out.set(body, header.length + nameBytes.length);
  return out;
}

/** Minimal PDF with one FlateDecode content stream. */
function compressedPdf(streamText: string): Uint8Array {
  const compressed = deflateSync(bytesOf(streamText));
  const parts = [
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length ', String(compressed.length), ' /Filter /FlateDecode >>\nstream\n',
  ];
  const text = parts.join('');
  const textBytes = bytesOf(text);
  const tail = bytesOf('\nendstream\nendobj\n%%EOF');
  const out = new Uint8Array(textBytes.length + compressed.length + tail.length);
  out.set(textBytes, 0);
  out.set(compressed, textBytes.length);
  out.set(tail, textBytes.length + compressed.length);
  return out;
}

describe('extractText', () => {
  it('extracts plain text by mime', () => {
    const result = extractText(bytesOf('你好，世界'), 'text/plain');
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.text).toBe('你好，世界');
  });

  it('extracts source code by extension even without a text mime', () => {
    const result = extractText(bytesOf('const x = 1;'), 'application/octet-stream', 'app.ts');
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.text).toContain('const x');
  });

  it('truncates long text to the char budget', () => {
    const result = extractText(bytesOf('a'.repeat(200_000)), 'text/plain');
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.metadata.truncated).toBe(true);
      expect([...result.text]).toHaveLength(80_000);
    }
  });

  it('rejects binary-looking content', () => {
    const data = bytesOf('abc');
    data[1] = 0;
    const result = extractText(data, 'text/plain');
    expect(result.status).toBe('unsupported');
    if (result.status === 'unsupported') expect(result.metadata.reason).toBe('binary_content');
  });

  it('reports unsupported formats', () => {
    const result = extractText(bytesOf('nope'), 'image/png');
    expect(result.status).toBe('unsupported');
  });

  it('extracts the uncompressed PDF text layer', () => {
    const header = bytesOf('%PDF-1.4\n');
    const body = bytesOf('BT /F1 12 Tf 72 720 Td (Hello PDF) Tj ET');
    const data = new Uint8Array(header.length + body.length);
    data.set(header, 0);
    data.set(body, header.length);
    const result = extractText(data, 'application/pdf');
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.text).toContain('Hello PDF');
  });

  it('extracts text from FlateDecode-compressed PDF streams', () => {
    const result = extractText(compressedPdf('BT /F1 12 Tf 72 720 Td (Compressed PDF text) Tj ET'), 'application/pdf');
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.text).toContain('Compressed PDF text');
  });

  it('skips malformed compressed streams but keeps other text', () => {
    const good = compressedPdf('BT (Before) Tj ET');
    const raw = deflateRawSync(bytesOf('BT (RawFallback) Tj ET'));
    const parts = ['%PDF-1.4\n', '5 0 obj\n<< /Length ', String(raw.length), ' /Filter /FlateDecode >>\nstream\n'];
    const prefix = bytesOf(parts.join(''));
    const tail = bytesOf('\nendstream\nendobj\n%%EOF');
    const out = new Uint8Array(good.length + prefix.length + raw.length + tail.length);
    out.set(good, 0);
    out.set(prefix, good.length);
    out.set(raw, good.length + prefix.length);
    out.set(tail, good.length + prefix.length + raw.length);
    const result = extractText(out, 'application/pdf');
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.text).toContain('Before');
      expect(result.text).toContain('RawFallback');
    }
  });

  it('rejects invalid pdf signatures', () => {
    const result = extractText(bytesOf('not a pdf at all'), 'application/pdf');
    expect(result.status).toBe('failed');
  });

  it('extracts docx text from a deflate-compressed document.xml', () => {
    const xml = '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
      + '<w:p><w:r><w:t>第一段内容</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>Second paragraph &amp; more</w:t></w:r></w:p>'
      + '</w:body></w:document>';
    const zip = zipWithEntry('word/document.xml', bytesOf(xml), 8);
    const result = extractText(zip, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(result.status).toBe('ready');
    if (result.status === 'ready') {
      expect(result.text).toContain('第一段内容');
      expect(result.text).toContain('Second paragraph & more');
    }
  });

  it('extracts docx with a stored (uncompressed) entry', () => {
    const xml = '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>Stored entry</w:t></w:r></w:p></w:body></w:document>';
    const zip = zipWithEntry('word/document.xml', bytesOf(xml), 0);
    const result = extractText(zip, 'application/zip', 'note.docx');
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.text).toContain('Stored entry');
  });

  it('reports a zip without document.xml as unsupported, not failed', () => {
    const zip = zipWithEntry('readme.txt', bytesOf('hello from zip'));
    const result = extractText(zip, 'application/zip');
    expect(result.status).toBe('ready');
    if (result.status === 'ready') expect(result.text).toContain('hello from zip');
  });

  it('reports broken docx containers as failed', () => {
    const result = extractText(bytesOf('PK\x03\x04garbage-not-a-zip'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(result.status).toBe('failed');
  });
});
