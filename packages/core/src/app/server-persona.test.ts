import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SERVER_PERSONA,
  SERVER_REFERENCE_IMAGES,
  mergeServerImagePersonaSeed,
  mergeServerPersonaSeed
} from './server-persona.js';

describe('server persona migration', () => {
  it('fills the server system prompt and bundled references into a minimal local persona', () => {
    const migrated = mergeServerPersonaSeed({ name: 'SOOYA', avatar: '/custom-avatar.png' });
    expect(migrated.name).toBe('SOOYA');
    expect(migrated.avatar).toBe('/custom-avatar.png');
    expect(migrated.systemPrompt).toBe(DEFAULT_SERVER_PERSONA.systemPrompt);
    expect(migrated.referenceImages).toEqual([...SERVER_REFERENCE_IMAGES]);
  });

  it('does not overwrite later user persona edits', () => {
    const migrated = mergeServerPersonaSeed({
      systemPrompt: '我的自定义人设',
      referenceImages: ['/mine/front.png'],
      stickerPolicy: { frequency: 'high' }
    });
    expect(migrated.systemPrompt).toBe('我的自定义人设');
    expect(migrated.referenceImages).toEqual(['/mine/front.png']);
    expect(migrated.stickerPolicy).toMatchObject({ enabled: true, frequency: 'high', maxPerReply: 1 });
  });

  it('ports the visual persona while preserving existing appearance edits', () => {
    const migrated = mergeServerImagePersonaSeed({ appearance: { hair: 'custom hair' } });
    expect(migrated.appearance).toMatchObject({ hair: 'custom hair', body: 'slim build, approximately 162cm height' });
    expect(migrated.reference_images).toEqual([...SERVER_REFERENCE_IMAGES]);
  });
});
