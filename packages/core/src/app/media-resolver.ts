import type { CreateMediaInput, MediaRow } from '../db/media.repo.js';
import type { MediaPlatform, MediaRecord, MediaSaveRequest } from '../platform/media.js';

/** Minimal row shape the resolver needs from the media repository. */
export interface MediaLocationRow {
  id: string;
  origin: string;
  rel_path: string;
}

type MediaCatalog = {
  get(id: string): Promise<MediaLocationRow | undefined>;
  create(input: CreateMediaInput): Promise<MediaRow>;
};

/**
 * Resolves business media ids (`media_xxx`, builtin ids) to the physical
 * location the backing platform store understands, so no business code ever
 * guesses a native id:
 *
 *   media.id → media row → origin==='builtin' ? row.id (bundle asset key)
 *                          : row.rel_path (native SOOYAMedia UUID)
 *
 * Normal uploads still pass their native physical id back to LocalCore, which
 * creates the `media` row itself. Generated reply media is different: the reply
 * coordinator immediately attaches save().id to message_parts.media_id, so the
 * resolver must first register generated files and return the logical media id.
 */
export class LocalMediaResolver implements MediaPlatform {
  constructor(
    private readonly repo: MediaCatalog,
    private readonly backing: MediaPlatform
  ) {}

  async save(request: MediaSaveRequest): Promise<MediaRecord> {
    const saved = await this.backing.save(request);
    if (request.metadata?.generated !== true) return saved;

    const bytes = request.data instanceof Uint8Array ? request.data : new Uint8Array(request.data);
    try {
      const row = await this.repo.create({
        kind: saved.kind,
        relPath: saved.id,
        mime: saved.mime,
        bytes: saved.bytes || bytes.byteLength,
        sha256: await sha256Hex(bytes),
        width: saved.width ?? null,
        height: saved.height ?? null,
        duration: saved.durationSec ?? null,
        origin: 'generated',
        meta: {
          ...(request.metadata ?? {}),
          ...((saved.name ?? request.name) ? { name: saved.name ?? request.name } : {})
        }
      });
      return {
        id: row.id,
        kind: row.kind,
        mime: row.mime,
        bytes: row.bytes,
        ...(row.width !== null ? { width: row.width } : {}),
        ...(row.height !== null ? { height: row.height } : {}),
        ...(row.duration !== null ? { durationSec: row.duration } : {}),
        ...((saved.name ?? request.name) ? { name: saved.name ?? request.name } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {})
      };
    } catch (error) {
      // A DB failure must not leave an unreachable native file behind.
      await this.backing.remove(saved.id).catch(() => false);
      throw error;
    }
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
