/**
 * Pure-TS DEFLATE decompression (RFC 1951) + zlib wrapper (RFC 1950).
 *
 * Core is a zero-Node-dependency package (see test/boundary.test.ts), so this
 * deliberately does NOT use node:zlib. The implementation covers stored,
 * fixed-Huffman and dynamic-Huffman blocks, which is everything real-world
 * PDF/zip content uses. Output is capped so a hostile file cannot exhaust
 * memory; malformed input throws instead of looping.
 */

/** Safety cap on decompressed output (64 MiB). */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** LSB-first bit reader over a byte array (deflate bit order). */
class BitReader {
  private bitBuf = 0;
  private bitCount = 0;
  constructor(private readonly data: Uint8Array, private pos = 0) {}

  readBits(count: number): number {
    let result = 0;
    for (let index = 0; index < count; index += 1) {
      if (this.bitCount === 0) {
        if (this.pos >= this.data.length) throw new Error('inflate: unexpected end of input');
        this.bitBuf = this.data[this.pos]!;
        this.pos += 1;
        this.bitCount = 8;
      }
      result |= (this.bitBuf & 1) << index;
      this.bitBuf >>= 1;
      this.bitCount -= 1;
    }
    return result;
  }

  /** Discard remaining bits of the current byte (stored blocks). */
  align(): void {
    this.bitCount = 0;
  }
}

interface HuffmanTable {
  /** code → symbol, per bit length (index 1..15). */
  byLength: Map<number, number>[];
}

/** Build a canonical Huffman decode table; throws on oversubscribed trees. */
function buildHuffman(lengths: Uint8Array): HuffmanTable {
  const byLength: Map<number, number>[] = Array.from({ length: 16 }, () => new Map<number, number>());
  const blCount = new Int32Array(16);
  for (const length of lengths) {
    if (length > 0) blCount[length]! += 1;
  }
  let left = 1;
  for (let len = 1; len <= 15; len += 1) {
    left = (left << 1) - blCount[len]!;
    if (left < 0) throw new Error('inflate: oversubscribed huffman tree');
  }
  const nextCode = new Int32Array(16);
  let code = 0;
  for (let len = 1; len <= 15; len += 1) {
    code = (code + blCount[len - 1]!) << 1;
    nextCode[len] = code;
  }
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (length === 0) continue;
    byLength[length]!.set(nextCode[length]!, index);
    nextCode[length]! += 1;
  }
  return { byLength };
}

function decodeSymbol(reader: BitReader, table: HuffmanTable): number {
  let code = 0;
  for (let len = 1; len <= 15; len += 1) {
    code = (code << 1) | reader.readBits(1);
    const symbol = table.byLength[len]!.get(code);
    if (symbol !== undefined) return symbol;
  }
  throw new Error('inflate: invalid huffman code');
}

class OutBuffer {
  private buffer = new Uint8Array(1 << 16);
  private length = 0;

  write(byte: number): void {
    if (this.length === this.buffer.length) {
      const grown = new Uint8Array(this.buffer.length * 2);
      grown.set(this.buffer);
      this.buffer = grown;
    }
    this.buffer[this.length] = byte;
    this.length += 1;
  }

  bytes(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

interface CopyContext {
  window: Uint8Array;
  windowPos: number;
  out: OutBuffer;
  total: number;
}

function copyFromWindow(ctx: CopyContext, distance: number, length: number): void {
  if (distance === 0 || distance > ctx.total) throw new Error('inflate: invalid back reference');
  for (let index = 0; index < length; index += 1) {
    const byte = ctx.window[(ctx.windowPos - distance + 32_768) & 32_767]!;
    writeByte(ctx, byte);
  }
}

function writeByte(ctx: CopyContext, byte: number): void {
  ctx.out.write(byte);
  ctx.total += 1;
  if (ctx.total > MAX_OUTPUT_BYTES) throw new Error('inflate: output exceeds safety cap');
  ctx.window[ctx.windowPos] = byte;
  ctx.windowPos = (ctx.windowPos + 1) & 32_767;
}

function inflateBlock(reader: BitReader, literal: HuffmanTable, distance: HuffmanTable, ctx: CopyContext): void {
  for (;;) {
    const symbol = decodeSymbol(reader, literal);
    if (symbol < 256) {
      writeByte(ctx, symbol);
      continue;
    }
    if (symbol === 256) return; // end of block
    const lengthIndex = symbol - 257;
    if (lengthIndex < 0 || lengthIndex >= 29) throw new Error('inflate: invalid length code');
    const length = LENGTH_BASE[lengthIndex]! + reader.readBits(LENGTH_EXTRA[lengthIndex]!);
    const distanceSymbol = decodeSymbol(reader, distance);
    if (distanceSymbol >= 30) throw new Error('inflate: invalid distance code');
    const dist = DIST_BASE[distanceSymbol]! + reader.readBits(DIST_EXTRA[distanceSymbol]!);
    copyFromWindow(ctx, dist, length);
  }
}

/** Fixed literal/length table (RFC 1951 §3.2.6). */
function fixedLiteralTable(): HuffmanTable {
  const lengths = new Uint8Array(288);
  for (let index = 0; index < 144; index += 1) lengths[index] = 8;
  for (let index = 144; index < 256; index += 1) lengths[index] = 9;
  for (let index = 256; index < 280; index += 1) lengths[index] = 7;
  for (let index = 280; index < 288; index += 1) lengths[index] = 8;
  return buildHuffman(lengths);
}

/** Fixed distance table: 30 codes of 5 bits. */
function fixedDistanceTable(): HuffmanTable {
  return buildHuffman(new Uint8Array(30).fill(5));
}

const FIXED_LITERAL = fixedLiteralTable();
const FIXED_DISTANCE = fixedDistanceTable();

/** Decompress a raw DEFLATE stream (RFC 1951, no zlib header/trailer). */
export function inflateRaw(data: Uint8Array): Uint8Array {
  const reader = new BitReader(data);
  const ctx: CopyContext = { window: new Uint8Array(32_768), windowPos: 0, out: new OutBuffer(), total: 0 };
  for (;;) {
    const final = reader.readBits(1) === 1;
    const type = reader.readBits(2);
    if (type === 0) {
      // Stored block: byte-aligned length + one's complement.
      reader.align();
      const length = reader.readBits(16);
      const check = reader.readBits(16);
      if ((length ^ 0xffff) !== check) throw new Error('inflate: stored block length mismatch');
      for (let index = 0; index < length; index += 1) writeByte(ctx, reader.readBits(8));
    } else if (type === 1) {
      inflateBlock(reader, FIXED_LITERAL, FIXED_DISTANCE, ctx);
    } else if (type === 2) {
      const literalCount = reader.readBits(5) + 257;
      const distanceCount = reader.readBits(5) + 1;
      const codeLengthCount = reader.readBits(4) + 4;
      const codeLengths = new Uint8Array(19);
      for (let index = 0; index < codeLengthCount; index += 1) {
        codeLengths[CL_ORDER[index]!] = reader.readBits(3);
      }
      const codeLengthTable = buildHuffman(codeLengths);
      const lengths = new Uint8Array(literalCount + distanceCount);
      let index = 0;
      while (index < lengths.length) {
        const symbol = decodeSymbol(reader, codeLengthTable);
        if (symbol < 16) {
          lengths[index] = symbol;
          index += 1;
        } else if (symbol === 16) {
          if (index === 0) throw new Error('inflate: repeat with no previous length');
          const repeat = 3 + reader.readBits(2);
          for (let r = 0; r < repeat && index < lengths.length; r += 1) {
            lengths[index] = lengths[index - 1]!;
            index += 1;
          }
        } else if (symbol === 17) {
          const repeat = 3 + reader.readBits(3);
          for (let r = 0; r < repeat && index < lengths.length; r += 1) {
            lengths[index] = 0;
            index += 1;
          }
        } else {
          const repeat = 11 + reader.readBits(7);
          for (let r = 0; r < repeat && index < lengths.length; r += 1) {
            lengths[index] = 0;
            index += 1;
          }
        }
      }
      const literal = buildHuffman(lengths.subarray(0, literalCount));
      const distance = buildHuffman(lengths.subarray(literalCount));
      inflateBlock(reader, literal, distance, ctx);
    } else {
      throw new Error('inflate: reserved block type');
    }
    if (final) break;
  }
  return ctx.out.bytes();
}

function zlibHeaderValid(cmf: number, flg: number): boolean {
  if ((cmf & 0x0f) !== 8) return false; // deflate method
  if ((cmf >> 4) > 7) return false; // window size 2^(cmf>>4 + 8), cap at 32768
  return ((cmf << 8) | flg) % 31 === 0;
}

/**
 * Decompress a zlib stream (RFC 1950: 2-byte header, deflate body, 4-byte
 * Adler-32 trailer). The trailer is not verified — extraction only needs the
 * payload, and verification cost is not worth it for bounded local files.
 */
export function inflateZlib(data: Uint8Array): Uint8Array {
  if (data.length < 2) throw new Error('inflate: not a zlib stream');
  if (!zlibHeaderValid(data[0]!, data[1]!)) throw new Error('inflate: bad zlib header');
  return inflateRaw(data.subarray(2));
}

/**
 * Best-effort inflate for PDF FlateDecode streams: PDF uses zlib-wrapped
 * streams per spec, but some producers emit raw deflate. Try zlib first,
 * then fall back to raw.
 */
export function inflatePdf(data: Uint8Array): Uint8Array {
  if (data.length > 2 && zlibHeaderValid(data[0]!, data[1]!)) {
    try {
      return inflateZlib(data);
    } catch {
      // fall through to raw
    }
  }
  return inflateRaw(data);
}
