import { describe, expect, it } from 'vitest';
import { normalizeLocalMediaContentType, sniffAudioMime } from './authenticatedMedia.js';

describe('local audio MIME recovery', () => {
  it('detects MP3 ID3 data', () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
    expect(sniffAudioMime(bytes)).toBe('audio/mpeg');
    expect(normalizeLocalMediaContentType(bytes, 'application/octet-stream', 'audio')).toBe('audio/mpeg');
  });

  it('detects WAV data', () => {
    const bytes = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0,
      0x57, 0x41, 0x56, 0x45
    ]);
    expect(sniffAudioMime(bytes)).toBe('audio/wav');
    expect(normalizeLocalMediaContentType(bytes, 'application/binary', 'audio')).toBe('audio/wav');
  });

  it('keeps explicit audio MIME unchanged', () => {
    const bytes = new Uint8Array([0x49, 0x44, 0x33]);
    expect(normalizeLocalMediaContentType(bytes, 'audio/mpeg', 'audio')).toBe('audio/mpeg');
  });

  it('does not disguise unknown generic bytes as audio', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(normalizeLocalMediaContentType(bytes, 'application/octet-stream', 'audio')).toBe('application/octet-stream');
  });
});
