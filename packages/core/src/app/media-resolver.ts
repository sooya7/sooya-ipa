import type { MediaPlatform, MediaRecord, MediaSaveRequest } from '../platform/media.js';

/** Minimal row shape the resolver needs from the media repository. */
export interface MediaLocationRow {
  id: string;
  origin: string;
  rel_path: string;
}

/**
 * Resolves business media ids (`media_xxx`, builtin ids) to the physical
 * location the backing platform store understands, so no business code ever
 * guesses a native id:
 *
 *   media.id → media row → origin==='builtin' ? row.id (bundle asset key)
 *                          : row.rel_path (native SOOYAMedia UUID)
 *
 * `save` is passed through untouched: it already returns the native physical
 * id, which `upload` persists as rel_path. A missing row resolves to null /
 * false instead of leaking an "Invalid media id" native error upward.
 */
export class LocalMediaResolver implements MediaPlatform {
  constructor(
    private readonly repo: { get(id: string): Promise<MediaLocationRow | undefined> },
    private readonly backing: MediaPlatform
  ) {}

  async save(request: MediaSaveRequest): Promise<MediaRecord> {
    return await this.backing.save(request);
  }

  async read(id: string): Promise<{ record: MediaRecord; data: Uint8Array } | null> {
    const row = await this.repo.get(id);
    if (!row) return null;
    return await this.backing.read(row.origin === 'builtin' ? row.id : row.rel_path);
  }

  async remove(id: string): Promise<boolean> {
    const row = await this.repo.get(id);
    if (!row) return false;
    return await this.backing.remove(row.origin === 'builtin' ? row.id : row.rel_path);
  }
}
