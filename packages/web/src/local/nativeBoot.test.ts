import { describe, expect, it } from 'vitest';
import { selectReferenceFraming } from './nativeBoot.js';

describe('selfie reference framing selection', () => {
  it('matches the server composition rules', () => {
    expect(selectReferenceFraming('我侧着脸看窗外')).toBe('side');
    expect(selectReferenceFraming('侧颜自拍')).toBe('side');
    expect(selectReferenceFraming('profile portrait')).toBe('side');
    expect(selectReferenceFraming('站在镜子前拍一张全身照')).toBe('full-body');
    expect(selectReferenceFraming('full body standing shot')).toBe('full-body');
    expect(selectReferenceFraming('head to toe shot')).toBe('full-body');
    expect(selectReferenceFraming('坐在窗边喝咖啡')).toBe('front');
    expect(selectReferenceFraming(undefined)).toBe('front');
  });
});
