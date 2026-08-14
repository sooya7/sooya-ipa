import { describe, expect, it } from 'vitest';
import { migrateDatabase } from '../db/migrations.js';
import { NodeLocalDatabase } from '../../test/db/node-local-database.js';
import { MediaRepo, SettingsRepo } from '../db/index.js';
import { PersonaReferenceService, REFERENCE_BUILTIN_PATHS } from './persona-reference-service.js';

describe('PersonaReferenceService', () => {
  it('defaults all three slots to the bundled assets on a fresh install', async () => {
    const db = new NodeLocalDatabase();
    await migrateDatabase(db);
    try {
      const service = new PersonaReferenceService(new SettingsRepo(db));
      const items = await service.list();
      expect(items).toHaveLength(3);
      expect(items.map((item) => item.framing)).toEqual(['front', 'full-body', 'side']);
      for (const item of items) {
        expect(item.mediaId).toBeNull();
        expect(item.configured).toBe(true);
        expect(item.exists).toBe(true);
        expect(item.builtinPath).toBe(REFERENCE_BUILTIN_PATHS[item.framing]);
      }
      expect(await service.activeSlots()).toEqual({ front: null, 'full-body': null, side: null });
    } finally {
      await db.close();
    }
  });

  it('switches a slot to the uploaded media and falls back to builtin on delete', async () => {
    const db = new NodeLocalDatabase();
    await migrateDatabase(db);
    try {
      const mediaRepo = new MediaRepo(db);
      const service = new PersonaReferenceService(new SettingsRepo(db), mediaRepo);
      const row = await mediaRepo.create({
        kind: 'image', relPath: '11111111-2222-3333-4444-555555555555', mime: 'image/png', bytes: 2048,
        sha256: 'sha-ref', origin: 'upload', meta: { referenceSlot: 'front' }
      });
      await service.upload('front', row.id);

      const list = await service.list();
      const front = list.find((item) => item.framing === 'front')!;
      expect(front.mediaId).toBe(row.id);
      expect(front.bytes).toBe(2048);
      expect(front.builtinPath).toBe('');
      // Other slots still use the builtin assets.
      expect(list.find((item) => item.framing === 'side')!.mediaId).toBeNull();
      expect(await service.activeSlots()).toEqual({ front: row.id, 'full-body': null, side: null });

      const removed = await service.remove(row.id);
      expect(removed.framing).toBe('front');
      const after = (await service.list()).find((item) => item.framing === 'front')!;
      expect(after.mediaId).toBeNull();
      expect(after.builtinPath).toBe(REFERENCE_BUILTIN_PATHS.front);
    } finally {
      await db.close();
    }
  });

  it('deleting an unknown target changes nothing', async () => {
    const db = new NodeLocalDatabase();
    await migrateDatabase(db);
    try {
      const service = new PersonaReferenceService(new SettingsRepo(db));
      const result = await service.remove('media_missing');
      expect(result.framing).toBeNull();
      expect((await service.list()).every((item) => item.mediaId === null)).toBe(true);
    } finally {
      await db.close();
    }
  });
});
