import type { LifeV2Repo, LifeShareCandidateRow } from '../db/life.repo.js';
import type { MomentRepo } from '../db/moment.repo.js';
import type { MediaPlatform } from '../platform/media.js';
import type { ChatProvider, ImageProvider } from '../providers/types.js';
import type { MediaDirector } from '../app/media-director.js';
import { fallbackImagePrompt } from '../app/media-director.js';
import type { PersonaReferenceService } from '../app/persona-reference-service.js';
import { MomentPolicy, type MomentCandidate, type MomentRecord } from './moment-policy.js';
import { MomentImagePolicy, type MomentSharePlan } from './moment-image-policy.js';

export interface MomentComposeResult {
  accepted: number;
  rejected: number;
  created: string[];
  imagesPlanned: number;
  imagesCreated: number;
  imageFailures: number;
}

export interface MomentComposerOptions {
  life: LifeV2Repo;
  moments: MomentRepo;
  provider?: ChatProvider | null | (() => Promise<ChatProvider | null>);
  imageProvider?: ImageProvider | null | (() => Promise<ImageProvider | null>);
  mediaDirector?: MediaDirector | null | (() => MediaDirector | null);
  media?: MediaPlatform | null;
  personaReferences?: PersonaReferenceService | null;
  referenceImages?: (hint?: string) => Promise<Array<{ data: Uint8Array; mime: string }>>;
  policy?: MomentPolicy;
  imagePolicy?: MomentImagePolicy;
  now?: () => Date;
}

/**
 * Selects and persists the local Moment chain. Moment text remains
 * provider-optional; generated images (POV/selfie) are an optional second
 * lane governed by daily cap, minimum gap and candidate importance, and any
 * image failure degrades to a text-only Moment.
 */
export class MomentComposer {
  private readonly now: () => Date;

  constructor(private readonly options: MomentComposerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async compose(now = this.now(), policy = this.options.policy ?? new MomentPolicy()): Promise<MomentComposeResult> {
    const pending = await this.options.life.pendingCandidates();
    const existingRows = await this.options.moments.list(100);
    const existing: MomentRecord[] = existingRows.map((row) => ({ id: row.id, candidateId: row.candidate_id, topic: row.topic_key ?? row.activity, createdAt: row.created_at }));
    const candidates = pending.map(toCandidate);
    const selected = policy.select(candidates, existing, now, true);
    const rejectedIds = new Set(selected.rejected.map((item) => item.id));
    for (const candidate of pending) if (rejectedIds.has(candidate.id)) await this.options.life.updateShareCandidate(candidate.id, { status: 'suppressed' }).catch(() => undefined);

    const created: string[] = [];
    const provider = (typeof this.options.provider === 'function' ? await this.options.provider() : this.options.provider) ?? null;
    const imageProvider = (typeof this.options.imageProvider === 'function' ? await this.options.imageProvider() : this.options.imageProvider) ?? null;
    const mediaDirector = (typeof this.options.mediaDirector === 'function' ? await this.options.mediaDirector() : this.options.mediaDirector) ?? null;
    const imagePolicy = this.options.imagePolicy ?? new MomentImagePolicy();
    let imagesPlanned = 0;
    let imagesCreated = 0;
    let imageFailures = 0;

    for (const candidate of selected.accepted) {
      const source = pending.find((item) => item.id === candidate.id)!;
      const meta = parseMeta(source.meta_json);
      const text = await this.composeText(candidate, meta, provider);
      const sharePlan: MomentSharePlan = {
        text,
        image: imagePolicy.decide({
          candidate: {
            activity: candidate.activity,
            topic: candidate.topic,
            occurredAt: candidate.occurredAt,
            importance: candidate.importance ?? 0,
            meta
          },
          existing: existingRows.map((row) => ({ createdAt: row.created_at, hasImage: row.image_media_id !== null, imageKind: row.image_kind })),
          now,
          providerConfigured: Boolean(imageProvider?.configured),
          mediaAvailable: Boolean(this.options.media)
        })
      };

      let imageMediaId: string | null = null;
      let imageKind: 'pov' | 'selfie' | null = null;
      if (sharePlan.image && imageProvider?.configured && this.options.media) {
        imagesPlanned += 1;
        try {
          const generated = await this.generateMomentImage(sharePlan, imageProvider, mediaDirector);
          const record = await this.options.media.save({
            kind: 'image',
            data: generated.data,
            mime: generated.mime,
            name: `sooya-moment-${Date.now()}.image`,
            metadata: { generated: true, moment: true, kind: sharePlan.image.kind, prompt: generated.prompt }
          });
          imageMediaId = record.id;
          imageKind = sharePlan.image.kind;
          imagesCreated += 1;
        } catch {
          // Image failure must never suppress the text Moment.
          imageFailures += 1;
        }
      }

      const row = await this.options.moments.create({
        candidateId: candidate.id,
        text: sharePlan.text,
        activity: candidate.activity,
        imageMediaId,
        imageKind,
        locationId: typeof meta.locationId === 'string' ? meta.locationId : null,
        locationName: typeof meta.locationName === 'string' ? meta.locationName : null,
        city: typeof meta.city === 'string' ? meta.city : null,
        topicKey: candidate.topic,
        sourceEventId: source.source_id,
        createdAt: candidate.createdAt,
        status: 'published'
      });
      await this.options.life.updateShareCandidate(source.id, { status: 'shared', shared_at: candidate.createdAt });
      created.push(row.id);
    }
    return { accepted: selected.accepted.length, rejected: selected.rejected.length, created, imagesPlanned, imagesCreated, imageFailures };
  }

  private async composeText(candidate: MomentCandidate, meta: Record<string, unknown>, provider: ChatProvider | null): Promise<string> {
    let text = `${candidate.activity}的时候，${String(meta.detail ?? '留下一点今天的痕迹')}`.trim();
    if (provider?.configured) {
      try {
        const result = await provider.complete({
          system: '为 SOOYA 写一句克制、具体、不夸张的生活动态，不要编造地点或人物。只输出一句中文。',
          messages: [{ role: 'user', content: [{ type: 'text', text: `活动：${candidate.activity}\n上下文：${JSON.stringify(meta)}` }] }],
          maxTokens: 120,
          temperature: 0.7
        });
        if (result.text.trim()) text = result.text.trim().slice(0, 240);
      } catch { /* deterministic text remains publishable */ }
    }
    return text;
  }

  private async generateMomentImage(
    plan: MomentSharePlan,
    provider: ImageProvider,
    director: MediaDirector | null
  ): Promise<{ data: Uint8Array | ArrayBuffer; mime: string; prompt: string }> {
    if (!plan.image) throw new Error('image plan missing');
    let finalImagePrompt = `${plan.image.scene}${plan.image.action ? `，${plan.image.action}` : ''}${plan.image.mood ? `，情绪：${plan.image.mood}` : ''}`.trim();
    const intent = plan.image.kind === 'selfie' ? 'selfie' : 'private snapshot';
    if (director) {
      try {
        const expanded = await director.image({ scene: finalImagePrompt.slice(0, 400), intent }, {});
        if (expanded.prompt.trim()) finalImagePrompt = expanded.prompt.trim();
      } catch {
        finalImagePrompt = fallbackImagePrompt({ scene: finalImagePrompt.slice(0, 400), intent });
      }
    }
    let references: Array<{ data: Uint8Array; mime: string }> = [];
    if (plan.image.kind === 'selfie') {
      const framing = this.options.personaReferences?.framingFor(finalImagePrompt) ?? plan.image.framing ?? 'front';
      const resolved = await this.options.referenceImages?.(`${finalImagePrompt} framing:${framing}`) ?? [];
      references = resolved.slice(0, 1);
      if (references.length === 0) throw new Error('persona reference unavailable');
    }
    const generated = await provider.generate(finalImagePrompt, {
      ...(references.length ? { referenceImages: references } : {})
    });
    return { data: generated.data, mime: generated.mime, prompt: finalImagePrompt };
  }
}

function toCandidate(row: LifeShareCandidateRow): MomentCandidate {
  const meta = parseMeta(row.meta_json);
  const scores = [row.novelty, row.relevance_to_user, row.emotional_value, row.urgency].filter((value) => typeof value === 'number' && Number.isFinite(value));
  const importance = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
  return {
    id: row.id,
    activity: typeof meta.activity === 'string' ? meta.activity : row.source_type,
    topic: typeof meta.topicKey === 'string' ? meta.topicKey : row.source_type,
    occurredAt: typeof meta.occurredAt === 'string' ? meta.occurredAt : row.created_at,
    status: 'pending',
    importance,
    meta
  };
}

function parseMeta(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
