import type { BuiltinStickerImportResult, BuiltinStickerSeed } from '@sooya/core/app';
import type { MediaPlatform, MediaRecord, MediaSaveRequest } from '@sooya/core/platform';
import manifest from './builtin-stickers.json';

export const BUILTIN_STICKERS = manifest as BuiltinStickerSeed[];

export async function readBuiltinStickerAsset(
  seed: BuiltinStickerSeed,
  fetcher: typeof fetch = fetch
): Promise<{ record: MediaRecord; data: Uint8Array } | null> {
  const response = await fetcher(seed.assetPath);
  if (!response.ok) return null;
  const data = new Uint8Array(await response.arrayBuffer());
  return {
    record: {
      id: seed.mediaId,
      kind: 'sticker',
      mime: seed.mime,
      bytes: data.byteLength,
      name: seed.name,
      width: seed.width ?? undefined,
      height: seed.height ?? undefined
    },
    data
  };
}

export class BuiltinStickerMedia implements MediaPlatform {
  private readonly byMediaId: Map<string, BuiltinStickerSeed>;
  private activeMediaIds = new Set<string>();

  constructor(
    private readonly backing: MediaPlatform,
    seeds: readonly BuiltinStickerSeed[] = BUILTIN_STICKERS,
    private readonly fetcher: typeof fetch = fetch
  ) {
    this.byMediaId = new Map(seeds.map((seed) => [seed.mediaId, seed]));
  }

  activate(ids: readonly string[]): void { this.activeMediaIds = new Set(ids); }

  assetUrl(id: string): string | null {
    return this.activeMediaIds.has(id) ? this.byMediaId.get(id)?.assetPath ?? null : null;
  }

  async save(request: MediaSaveRequest): Promise<MediaRecord> { return await this.backing.save(request); }

  async read(id: string): Promise<{ record: MediaRecord; data: Uint8Array } | null> {
    const builtin = this.activeMediaIds.has(id) ? this.byMediaId.get(id) : undefined;
    return builtin ? await readBuiltinStickerAsset(builtin, this.fetcher) : await this.backing.read(id);
  }

  async remove(id: string): Promise<boolean> {
    return this.activeMediaIds.has(id) ? false : await this.backing.remove(id);
  }
}

export async function afterAppReady(
  seed: () => Promise<BuiltinStickerImportResult>,
  activate: (ids: readonly string[]) => void,
  markReady: () => Promise<void>,
  rollback: (result: BuiltinStickerImportResult) => Promise<void>
): Promise<void> {
  const result = await seed();
  activate(result.mediaIds);
  try {
    await markReady();
  } catch (error) {
    activate([]);
    await rollback(result);
    throw error;
  }
}
