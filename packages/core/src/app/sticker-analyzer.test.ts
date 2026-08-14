import { describe, expect, it } from 'vitest';
import type { Sticker, StickerRepo } from '../db/sticker.repo.js';
import type { MediaPlatform, MediaRecord, MediaSaveRequest } from '../platform/media.js';
import type { ChatProvider, ChatRequest, ChatResult, HealthStatus } from '../providers/types.js';
import { StickerAnalyzer } from './sticker-analyzer.js';

function stickerRow(overrides: Partial<Sticker> = {}): Sticker {
  return {
    id: 'sticker-test-1', mediaId: 'media-1', name: '测试表情', nameSource: 'auto', description: '', imageText: '',
    tags: [], emotion: 'neutral', userMeaning: '', userMeaningSource: 'none', userMeaningConfidence: null, userMeaningUpdatedAt: null,
    analysisStatus: 'pending', analysisSource: 'legacy', analysisVersion: 0, analysisModel: null, analyzedAt: null, analysisError: null,
    embedding: null, embeddingDim: null, embeddingModel: null, favorite: false, useCount: 0, lastUsedAt: null,
    assistantUseCount: 0, assistantLastUsedAt: null, userUseCount: 0, userLastUsedAt: null, enabled: true,
    createdAt: '2026-08-14T00:00:00.000Z', updatedAt: '2026-08-14T00:00:00.000Z', semanticRevision: 0, url: '', ...overrides
  };
}

function fakeStickerRepo(rows: Sticker[]): StickerRepo {
  const repo = {} as StickerRepo;
  repo.get = async (id: string) => rows.find((row) => row.id === id);
  repo.setAnalysisState = async (id: string, patch: Record<string, unknown>) => {
    const row = rows.find((item) => item.id === id);
    if (!row) return undefined;
    if (patch.status !== undefined) row.analysisStatus = patch.status as Sticker['analysisStatus'];
    if (patch.source !== undefined) row.analysisSource = patch.source as Sticker['analysisSource'];
    if (patch.error !== undefined) row.analysisError = patch.error as string | null;
    if (patch.status === 'ready') row.analysisError = null;
    return row;
  };
  repo.applyAiAnalysis = async (id: string, patch: Record<string, unknown>) => {
    const row = rows.find((item) => item.id === id);
    if (!row || row.analysisSource === 'manual') return undefined;
    Object.assign(row, patch, { analysisStatus: 'ready', analysisSource: 'ai' });
    return row;
  };
  return repo;
}

function fakeMedia(): MediaPlatform {
  return {
    async save(_request: MediaSaveRequest): Promise<MediaRecord> { throw new Error('not used'); },
    async read() { return { record: { id: 'media-1', kind: 'image', mime: 'image/png', bytes: 4 } as MediaRecord, data: new Uint8Array([1, 2, 3, 4]) }; },
    async remove() { return true; }
  };
}

function fakeVision(text: string): ChatProvider {
  const provider = {
    name: 'vision-fake',
    configured: true,
    async complete(request: ChatRequest): Promise<ChatResult> {
      expect(request.messages[0]).toBeDefined();
      const first = request.messages[0]!;
      const content = (first as { content?: Array<{ type: string }> }).content ?? [];
      expect(content.some((part) => part.type === 'image')).toBe(true);
      return { text, model: 'vision-fake' };
    },
    async stream(): Promise<ChatResult> { throw new Error('not used'); },
    async inspectHealth(): Promise<HealthStatus> { return { capability: 'chat', configured: true, ok: true, provider: 'vision-fake', checkedAt: new Date().toISOString() }; }
  };
  return provider;
}

describe('StickerAnalyzer', () => {
  it('applies a valid analysis result and marks the sticker ready', async () => {
    const rows = [stickerRow()];
    const analyzer = new StickerAnalyzer(fakeStickerRepo(rows), fakeMedia(), () => fakeVision('{"suggestedName":"开心","description":"开心地挥手","imageText":"","tags":["开心","挥手"]}'));
    const result = await analyzer.analyze('sticker-test-1');
    expect(result).toMatchObject({ suggestedName: '开心', description: '开心地挥手', tags: ['开心', '挥手'] });
    expect(rows[0]).toMatchObject({ analysisStatus: 'ready', analysisSource: 'ai' });
  });

  it('skips manual stickers unless forced', async () => {
    const rows = [stickerRow({ analysisSource: 'manual', analysisStatus: 'ready' })];
    const analyzer = new StickerAnalyzer(fakeStickerRepo(rows), fakeMedia(), () => fakeVision('{}'));
    expect(await analyzer.analyze('sticker-test-1')).toBeNull();
    expect(rows[0]!.analysisSource).toBe('manual');
  });

  it('records failed state when the provider returns invalid JSON', async () => {
    const rows = [stickerRow()];
    const analyzer = new StickerAnalyzer(fakeStickerRepo(rows), fakeMedia(), () => fakeVision('not json'));
    await expect(analyzer.analyze('sticker-test-1')).rejects.toThrow();
    expect(rows[0]!.analysisStatus).toBe('failed');
  });

  it('marks pending when no vision provider is configured', async () => {
    const rows = [stickerRow()];
    const analyzer = new StickerAnalyzer(fakeStickerRepo(rows), fakeMedia(), () => null);
    expect(await analyzer.analyze('sticker-test-1')).toBeNull();
    expect(rows[0]!.analysisStatus).toBe('pending');
  });
});
