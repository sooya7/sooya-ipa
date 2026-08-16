export type MomentImageKind = 'pov' | 'selfie';

export interface MomentSharePlan {
  text: string;
  image: null | {
    kind: MomentImageKind;
    scene: string;
    action?: string;
    mood?: string;
    framing?: 'front' | 'full-body' | 'side';
  };
}

export interface MomentImageCandidate {
  activity: string;
  topic: string;
  occurredAt: string;
  importance: number;
  meta: Record<string, unknown>;
}

export interface MomentImageRecord {
  createdAt: string;
  hasImage: boolean;
  imageKind: MomentImageKind | null;
}

export interface MomentImagePolicyOptions {
  dailyImageCap?: number;
  minImageGapMs?: number;
  importanceThreshold?: number;
}

const IMAGE_SUITABLE_KINDS = new Set(['meal', 'out', 'play', 'social', 'walk', 'chore']);
const SELFIE_KINDS = new Set(['meal', 'social', 'play']);

/**
 * Decides whether a share candidate gets a generated image, and whether the
 * image is a POV or a persona selfie. Pure and deterministic: provider/media
 * availability are inputs, not side effects.
 */
export class MomentImagePolicy {
  private readonly dailyImageCap: number;
  private readonly minImageGapMs: number;
  private readonly importanceThreshold: number;

  constructor(options: MomentImagePolicyOptions = {}) {
    this.dailyImageCap = Math.max(0, Math.trunc(options.dailyImageCap ?? 1));
    this.minImageGapMs = Math.max(0, options.minImageGapMs ?? 6 * 60 * 60_000);
    this.importanceThreshold = options.importanceThreshold ?? 0.7;
  }

  decide(input: {
    candidate: MomentImageCandidate;
    existing: MomentImageRecord[];
    now: Date;
    providerConfigured: boolean;
    mediaAvailable: boolean;
  }): MomentSharePlan['image'] {
    if (!input.providerConfigured || !input.mediaAvailable || this.dailyImageCap <= 0) return null;
    const at = Date.parse(input.candidate.occurredAt);
    if (!Number.isFinite(at) || at > input.now.getTime()) return null;
    if (!IMAGE_SUITABLE_KINDS.has(input.candidate.topic) && !IMAGE_SUITABLE_KINDS.has(input.candidate.activity)) return null;
    if (input.candidate.importance < this.importanceThreshold) return null;
    const day = input.now.toISOString().slice(0, 10);
    const imagesToday = input.existing.filter((item) => item.hasImage && item.createdAt.slice(0, 10) === day).length;
    if (imagesToday >= this.dailyImageCap) return null;
    const lastImageAt = input.existing
      .filter((item) => item.hasImage)
      .map((item) => Date.parse(item.createdAt))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    if (lastImageAt !== undefined && at - lastImageAt < this.minImageGapMs) return null;

    const kind: MomentImageKind = SELFIE_KINDS.has(input.candidate.topic) || SELFIE_KINDS.has(input.candidate.activity) ? 'selfie' : 'pov';
    const mood = typeof input.candidate.meta.mood === 'string' ? input.candidate.meta.mood : undefined;
    const detail = typeof input.candidate.meta.detail === 'string' ? input.candidate.meta.detail : undefined;
    return {
      kind,
      scene: `${input.candidate.activity}的日常画面`,
      action: detail,
      mood,
      framing: kind === 'selfie' ? 'front' : undefined
    };
  }
}
