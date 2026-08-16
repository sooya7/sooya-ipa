import { beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../db/migrations.js';
import { NodeLocalDatabase } from '../../test/db/node-local-database.js';
import { LifeV2Repo, MediaRepo, MomentRepo } from '../db/index.js';
import type { MediaPlatform, MediaRecord, MediaSaveRequest } from '../platform/media.js';
import type { GeneratedImage, ImageProvider } from '../providers/types.js';
import { MomentComposer } from './composer.js';
import { MomentImagePolicy } from './moment-image-policy.js';

class MemoryMedia implements MediaPlatform {
  readonly saved: MediaSaveRequest[] = [];
  private next = 1;
  constructor(private readonly mediaRepo: MediaRepo) {}
  async save(request: MediaSaveRequest): Promise<MediaRecord> {
    this.saved.push(request);
    const data = request.data instanceof Uint8Array ? request.data : new Uint8Array(request.data);
    const id = `moment-media-${this.next++}`;
    await this.mediaRepo.create({ id, kind: request.kind, relPath: id, mime: request.mime ?? 'image/png', bytes: data.byteLength, sha256: `sha-${id}`, origin: 'generated' });
    return { id, kind: request.kind, mime: request.mime ?? 'image/png', bytes: data.byteLength, name: request.name };
  }
  async read(): Promise<{ record: MediaRecord; data: Uint8Array } | null> { return null; }
  async remove(): Promise<boolean> { return false; }
}

class FakeImageProvider implements ImageProvider {
  readonly name = 'fake-image';
  readonly configured = true;
  calls: Array<{ prompt: string; referenceCount: number }> = [];
  constructor(private readonly fail = false) {}
  async generate(prompt: string, options?: { referenceImages?: Array<{ data: Uint8Array; mime: string }> }): Promise<GeneratedImage> {
    this.calls.push({ prompt, referenceCount: options?.referenceImages?.length ?? 0 });
    if (this.fail) throw new Error('image generation failed');
    return { data: new TextEncoder().encode('fake-image-bytes'), mime: 'image/png' };
  }
  async edit(): Promise<GeneratedImage> { throw new Error('not used'); }
  async inspectHealth() { return { capability: 'image', configured: true, ok: true, provider: this.name, checkedAt: new Date().toISOString() }; }
}

async function setup(options: { provider?: FakeImageProvider; referenceImages?: (hint?: string) => Promise<Array<{ data: Uint8Array; mime: string }>> } = {}) {
  const db = new NodeLocalDatabase();
  await migrateDatabase(db);
  const now = new Date('2026-08-13T09:00:00.000Z');
  const life = new LifeV2Repo(db, () => now);
  const moments = new MomentRepo(db, () => now);
  const media = new MemoryMedia(new MediaRepo(db, () => now));
  const provider: FakeImageProvider = options.provider ?? new FakeImageProvider();
  const composer = new MomentComposer({
    life,
    moments,
    media,
    imageProvider: provider,
    mediaDirector: null,
    referenceImages: options.referenceImages,
    now: () => now
  });
  return { db, now, life, moments, media, provider, composer } as { db: NodeLocalDatabase; now: Date; life: LifeV2Repo; moments: MomentRepo; media: MemoryMedia; provider: FakeImageProvider; composer: MomentComposer };
}

async function addCandidate(life: LifeV2Repo, input: { activity: string; topic: string; occurredAt: string; importance?: number; detail?: string }) {
  return await life.addShareCandidate({
    sourceType: 'event',
    sourceId: `event-${input.activity}`,
    novelty: input.importance ?? 0.9,
    relevanceToUser: input.importance ?? 0.9,
    emotionalValue: input.importance ?? 0.9,
    urgency: 0.2,
    repetitionPenalty: 0,
    expiresAt: new Date(Date.parse(input.occurredAt) + 7 * 86_400_000).toISOString(),
    meta: {
      activity: input.activity,
      topicKey: input.topic,
      occurredAt: input.occurredAt,
      detail: input.detail ?? '今天的一点痕迹'
    }
  });
}

describe('MomentComposer image planner', () => {
  let now: Date;

  beforeEach(() => {
    now = new Date('2026-08-13T09:00:00.000Z');
  });

  it('creates POV images without persona references', async () => {
    const ctx = await setup();
    await addCandidate(ctx.life, { activity: '散步', topic: 'out', occurredAt: '2026-08-13T08:30:00.000Z', detail: '在河边走了一圈' });

    const result = await ctx.composer.compose(now);
    expect(result.imagesPlanned).toBe(1);
    expect(result.imagesCreated).toBe(1);
    const row = (await ctx.moments.list()).find((item) => item.activity === '散步');
    expect(row?.image_kind).toBe('pov');
    expect(row?.image_media_id).toBeTruthy();
    expect(ctx.provider.calls[0]?.referenceCount).toBe(0);
  });

  it('creates selfie images with one persona reference and front framing', async () => {
    const ctx = await setup({
      referenceImages: async () => [
        { data: new Uint8Array([1]), mime: 'image/png' },
        { data: new Uint8Array([2]), mime: 'image/png' }
      ]
    });
    await addCandidate(ctx.life, { activity: '见朋友', topic: 'social', occurredAt: '2026-08-13T08:10:00.000Z' });

    const result = await ctx.composer.compose(now);
    expect(result.imagesCreated).toBe(1);
    const row = (await ctx.moments.list()).find((item) => item.activity === '见朋友');
    expect(row?.image_kind).toBe('selfie');
    expect(ctx.provider.calls[0]?.referenceCount).toBe(1);
  });

  it('degrades image failure to a text-only moment', async () => {
    const ctx = await setup({ provider: new FakeImageProvider(true) });
    await addCandidate(ctx.life, { activity: '散步', topic: 'out', occurredAt: '2026-08-13T08:30:00.000Z' });

    const result = await ctx.composer.compose(now);
    expect(result.imageFailures).toBe(1);
    expect(result.created).toHaveLength(1);
    const row = (await ctx.moments.list())[0];
    expect(row?.image_media_id).toBeNull();
    expect(row?.text).toBeTruthy();
  });

  it('enforces daily image cap and minimum image gap', async () => {
    const policy = new MomentImagePolicy({ dailyImageCap: 1, minImageGapMs: 6 * 60 * 60_000, importanceThreshold: 0.5 });
    const today = [{ createdAt: '2026-08-13T08:00:00.000Z', hasImage: true, imageKind: 'pov' as const }];
    const capCandidate = { activity: '散步', topic: 'out', occurredAt: '2026-08-13T08:30:00.000Z', importance: 0.9, meta: {} };
    expect(policy.decide({ candidate: capCandidate, existing: today, now, providerConfigured: true, mediaAvailable: true })).toBeNull();

    const gapPolicy = new MomentImagePolicy({ dailyImageCap: 3, minImageGapMs: 6 * 60 * 60_000, importanceThreshold: 0.5 });
    const gapExisting = [{ createdAt: '2026-08-13T08:00:00.000Z', hasImage: true, imageKind: 'pov' as const }];
    const tooClose = { activity: '散步', topic: 'out', occurredAt: '2026-08-13T08:30:00.000Z', importance: 0.9, meta: {} };
    const enoughGap = { activity: '散步', topic: 'out', occurredAt: '2026-08-13T15:00:00.000Z', importance: 0.9, meta: {} };
    expect(gapPolicy.decide({ candidate: tooClose, existing: gapExisting, now, providerConfigured: true, mediaAvailable: true })).toBeNull();
    expect(gapPolicy.decide({ candidate: enoughGap, existing: gapExisting, now: new Date('2026-08-13T16:00:00.000Z'), providerConfigured: true, mediaAvailable: true })).not.toBeNull();
  });
});
