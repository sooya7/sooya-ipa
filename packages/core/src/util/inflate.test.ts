import { deflateRawSync, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { inflatePdf, inflateRaw, inflateZlib } from './inflate.js';

function bytes(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? new TextEncoder().encode(input) : input;
}

describe('inflateRaw', () => {
  it('round-trips fixed-huffman output (short ascii)', () => {
    for (const sample of ['', 'hello', 'hello world', 'The quick brown fox jumps over the lazy dog']) {
      const raw = deflateRawSync(bytes(sample));
      expect(bytes(inflateRaw(raw))).toEqual(bytes(sample));
    }
  });

  it('round-trips dynamic-huffman output (long repetitive text)', () => {
    const sample = 'SOOYA 手冲咖啡 '.repeat(200) + '今天多肉又冒了新芽 '.repeat(150);
    const raw = deflateRawSync(bytes(sample));
    expect(bytes(inflateRaw(raw))).toEqual(bytes(sample));
  });

  it('round-trips binary data with long back references', () => {
    const payload = new Uint8Array(300_000);
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 7 + 13) % 251;
    const raw = deflateRawSync(payload);
    expect(inflateRaw(raw)).toEqual(payload);
  });

  it('round-trips random small buffers', () => {
    for (let seed = 0; seed < 8; seed += 1) {
      let state = seed * 2654435761;
      const next = (): number => { state = (state * 1664525 + 1013904223) >>> 0; return state; };
      const payload = new Uint8Array(100 + next() % 4000);
      for (let index = 0; index < payload.length; index += 1) payload[index] = next() & 0xff;
      expect(inflateRaw(deflateRawSync(payload))).toEqual(payload);
    }
  });

  it('throws on truncated and garbage input instead of looping', () => {
    const good = deflateRawSync(bytes('hello world'));
    expect(() => inflateRaw(good.subarray(0, Math.floor(good.length / 2)))).toThrow();
    expect(() => inflateRaw(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow();
    expect(() => inflateRaw(new Uint8Array([0x01, 0x00, 0x00, 0x00, 0x00]))).toThrow(); // stored block length mismatch
  });
});

describe('inflateZlib', () => {
  it('round-trips zlib-wrapped streams', () => {
    for (const sample of ['', '中文内容测试', 'x'.repeat(10_000)]) {
      const wrapped = deflateSync(bytes(sample));
      expect(wrapped[0]! & 0x0f).toBe(8);
      expect(bytes(inflateZlib(wrapped))).toEqual(bytes(sample));
    }
  });

  it('rejects non-zlib headers', () => {
    expect(() => inflateZlib(new Uint8Array([0x01, 0x02]))).toThrow();
    expect(() => inflateZlib(new Uint8Array([0x78]))).toThrow();
  });
});

describe('inflatePdf', () => {
  it('decodes zlib-wrapped streams and falls back to raw deflate', () => {
    const sample = bytes('BT /F1 12 Tf (Hello PDF) Tj ET');
    expect(inflatePdf(deflateSync(sample))).toEqual(sample);
    expect(inflatePdf(deflateRawSync(sample))).toEqual(sample);
  });
});
