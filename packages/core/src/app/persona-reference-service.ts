import type { MediaRepo, SettingsRepo } from '../db/index.js';

/**
 * Persona reference-image management for the local runtime (server
 * routes/features.ts semantics mapped onto local storage).
 *
 * Three fixed framing slots (front / full-body / side). A slot defaults to a
 * bundled asset path (SERVER_REFERENCE_IMAGES); once the user uploads a
 * replacement it resolves to their media id; deleting the user image falls
 * back to the bundled asset again (the bundle file is never deleted).
 * The service returns metadata + byte resolution — bundled bytes are fetched
 * by the web layer (bundle assets), uploaded bytes through the media resolver.
 */

export type ReferenceFraming = 'front' | 'full-body' | 'side';

export const REFERENCE_FRAMINGS: readonly ReferenceFraming[] = ['front', 'full-body', 'side'];

/** Bundled reference assets, indexed by framing (server bundle order). */
export const REFERENCE_BUILTIN_PATHS: Record<ReferenceFraming, string> = {
  front: '/reference-images/01_main_reference_front_half.png',
  'full-body': '/reference-images/02_reference_full_body_standing.png',
  side: '/reference-images/03_reference_side_profile.png'
};

export interface PersonaReferenceItem {
  name: string;
  framing: ReferenceFraming;
  configured: boolean;
  exists: boolean;
  bytes: number;
  /** Set for user-uploaded slots; null means the bundled asset is active. */
  mediaId: string | null;
  builtinPath: string;
}

const SLOT_KEY = 'persona.referenceSlots';

export class PersonaReferenceService {
  constructor(
    private readonly settings: SettingsRepo,
    private readonly mediaRepo?: MediaRepo
  ) {}

  async list(): Promise<PersonaReferenceItem[]> {
    const slots = await this.settings.get<Record<string, string | null>>(SLOT_KEY, {});
    const items: PersonaReferenceItem[] = [];
    for (const framing of REFERENCE_FRAMINGS) {
      items.push(await this.item(framing, slots[framing] ?? null));
    }
    return items;
  }

  /** Active slot mapping: user media id where uploaded, null = builtin. */
  async activeSlots(): Promise<Record<ReferenceFraming, string | null>> {
    const slots = await this.settings.get<Record<string, string | null>>(SLOT_KEY, {});
    return {
      front: slots.front ?? null,
      'full-body': slots['full-body'] ?? null,
      side: slots.side ?? null
    };
  }

  async upload(framing: ReferenceFraming, mediaId: string): Promise<{ item: PersonaReferenceItem; previousMediaId: string | null }> {
    const slots = await this.settings.get<Record<string, string | null>>(SLOT_KEY, {});
    const previousMediaId = slots[framing] ?? null;
    slots[framing] = mediaId;
    await this.settings.set(SLOT_KEY, slots);
    return { item: await this.item(framing, mediaId), previousMediaId };
  }

  /** Removes a user image by media id or by slot; bundled assets stay put. */
  async remove(target: string): Promise<{ framing: ReferenceFraming | null; referenceImages: PersonaReferenceItem[] }> {
    const slots = await this.settings.get<Record<string, string | null>>(SLOT_KEY, {});
    let framing: ReferenceFraming | null = null;
    if (target in slots && slots[target]) {
      framing = target as ReferenceFraming;
      slots[target] = null;
    } else {
      for (const entry of Object.entries(slots)) {
        if (entry[1] === target) { framing = entry[0] as ReferenceFraming; slots[entry[0]] = null; break; }
      }
    }
    if (framing) await this.settings.set(SLOT_KEY, slots);
    return { framing, referenceImages: await this.list() };
  }

  private async item(framing: ReferenceFraming, mediaId: string | null): Promise<PersonaReferenceItem> {
    if (!mediaId) {
      return {
        name: `内置：${REFERENCE_BUILTIN_PATHS[framing].split('/').pop() ?? framing}`,
        framing,
        configured: true,
        exists: true,
        bytes: 0,
        mediaId: null,
        builtinPath: REFERENCE_BUILTIN_PATHS[framing]
      };
    }
    const row = this.mediaRepo ? await this.mediaRepo.get(mediaId).catch(() => undefined) : undefined;
    return {
      name: mediaId,
      framing,
      configured: true,
      exists: row !== undefined,
      bytes: row?.bytes ?? 0,
      mediaId,
      builtinPath: ''
    };
  }
}
