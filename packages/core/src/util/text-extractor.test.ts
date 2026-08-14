import { describe, expect, it } from 'vitest';
import { extractText } from './text-extractor.js';

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
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

  it('rejects invalid pdf signatures', () => {
    const result = extractText(bytesOf('not a pdf at all'), 'application/pdf');
    expect(result.status).toBe('failed');
  });

  it('reports docx/zip as unsupported in pure TS', () => {
    expect(extractText(bytesOf('x'), 'application/zip').status).toBe('unsupported');
    expect(extractText(bytesOf('x'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document').status).toBe('unsupported');
  });
});
