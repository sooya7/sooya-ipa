import type { GeneratedImage } from '../providers/types.js';
import {
  ImageJobUnsupportedError,
  isJobCapableImageProvider,
  type ImageJobLifecycleState,
  type JobCapableImageProvider
} from '../providers/durable-image-provider.js';
import type { ReplyFeatureRuntime } from './reply-feature-runtime.js';
import { ReplyCoordinator, type ReplyCoordinatorOptions } from './reply-coordinator.js';
import { fallbackImagePrompt } from './media-director.js';
import type { ChatMessage } from './types.js';

/**
 * Durable image-job adapter.
 *
 * ReplyCoordinator predates server-side image jobs and therefore waits for
 * ImageProvider.generate() before it appends an image part. This adapter keeps
 * that legacy path intact for every provider, but upgrades job-capable Anuma
 * providers without widening the coordinator's already-large media method:
 *
 * 1. persist a pending image part immediately;
 * 2. create the remote job and let the reply finish without waiting for it;
 * 3. poll in the background and replace that same part in-place;
 * 4. on app recovery, resume every pending part that carries a remote job id;
 * 5. if /image-jobs is unavailable, fall back to the old synchronous path,
 *    while still keeping the visible pending placeholder.
 *
 * The installer patches only the two coordinator seams required for this
 * compatibility transition. It can be deleted once image jobs become a first-
 * class ReplyCoordinator dependency.
 */

type EffectiveDirectives = {
  imagePrompt?: string | null;
  selfImagePrompt?: string | null;
  requiredImage?: boolean;
  stickers?: string[];
  noSticker?: boolean;
  [key: string]: unknown;
};

type ImageContext = {
  batchId: string;
  revision: number;
  sourceMessages: ChatMessage[];
};

type MediaAppendResult = {
  appended: number;
  imageAttempted: boolean;
  imageFailed: boolean;
  voiceOutcome?: unknown;
};

/** Structural view of the coordinator internals used by this transition shim.
 * Do not intersect this with ReplyCoordinator: its private `options` member
 * intentionally makes such an intersection reduce to `never` in TypeScript. */
type InternalCoordinator = {
  options: ReplyCoordinatorOptions;
  runtime(): ReplyFeatureRuntime | null;
};

type AppendImageMethod = (
  this: InternalCoordinator,
  messageId: string,
  directives: EffectiveDirectives,
  signal: AbortSignal,
  context: ImageContext
) => Promise<MediaAppendResult>;

type RecoverMethod = (this: InternalCoordinator) => Promise<void>;

type PatchedPrototype = {
  __sooyaImageJobsInstalled?: boolean;
  appendImageMedia: AppendImageMethod;
  recover: RecoverMethod;
};

const activeRecoveredParts = new Set<string>();

export function installReplyImageJobs(): void {
  const prototype = ReplyCoordinator.prototype as unknown as PatchedPrototype;
  if (prototype.__sooyaImageJobsInstalled) return;
  prototype.__sooyaImageJobsInstalled = true;

  const originalAppend: AppendImageMethod = prototype.appendImageMedia;
  const originalRecover: RecoverMethod = prototype.recover;

  prototype.appendImageMedia = async function (
    this: InternalCoordinator,
    messageId: string,
    directives: EffectiveDirectives,
    signal: AbortSignal,
    context: ImageContext
  ): Promise<MediaAppendResult> {
    const imagePrompt = cleanString(directives.selfImagePrompt) ?? cleanString(directives.imagePrompt);
    const imageRequested = Boolean(imagePrompt || directives.requiredImage);
    if (!imageRequested || signal.aborted) return await originalAppend.call(this, messageId, directives, signal, context);

    const selfImage = Boolean(cleanString(directives.selfImagePrompt));
    const clientRequestId = imageRequestId();
    let pendingMeta: Record<string, unknown> = {
      generated: true,
      selfImage,
      imageState: 'preparing',
      clientRequestId,
      prompt: imagePrompt ?? ''
    };
    const pendingPartId = await this.options.messages.appendPart(messageId, {
      type: 'image',
      status: 'pending',
      meta: pendingMeta
    });
    await emitMessageUpdated(this.options, messageId);

    const runtime = this.runtime();
    const provider = runtime?.imageProvider ? await runtime.imageProvider().catch(() => null) : null;
    if (imagePrompt && runtime && provider?.configured && isJobCapableImageProvider(provider)) {
      try {
        const prepared = await prepareImageJob(this, runtime, imagePrompt, selfImage, context, signal);
        // Persist the prepared request before POST /image-jobs. If iOS suspends
        // the app after the server accepts the POST but before its response is
        // stored locally, recovery can safely resubmit the same clientRequestId.
        pendingMeta = {
          ...pendingMeta,
          imageState: 'creating',
          preparedPrompt: prepared.prompt,
          ...(prepared.aspectRatio ? { aspectRatio: prepared.aspectRatio } : {}),
          ...(prepared.referenceMediaId ? { referenceMediaId: prepared.referenceMediaId, editedUserImage: true } : {})
        };
        await this.options.messages.updatePart(pendingPartId, { status: 'pending', meta: pendingMeta });
        await emitMessageUpdated(this.options, messageId);
        const lifecycle = {
          clientRequestId,
          onState: async (state: ImageJobLifecycleState) => {
            pendingMeta = {
              ...pendingMeta,
              imageState: state.state,
              ...(state.remoteJobId ? { remoteJobId: state.remoteJobId } : {}),
              ...(state.error ? { jobError: state.error } : {})
            };
            await this.options.messages.updatePart(pendingPartId, { status: 'pending', meta: pendingMeta });
            await emitMessageUpdated(this.options, messageId);
          }
        };
        const started = await provider.startJob(prepared.prompt, {
          signal,
          ...(prepared.references.length ? { referenceImages: prepared.references } : {})
        }, lifecycle);
        pendingMeta = {
          ...pendingMeta,
          imageState: 'queued',
          remoteJobId: started.jobId,
          ...(prepared.aspectRatio ? { aspectRatio: prepared.aspectRatio } : {}),
          ...(prepared.referenceMediaId ? { referenceMediaId: prepared.referenceMediaId, editedUserImage: true } : {})
        };
        await this.options.messages.updatePart(pendingPartId, { status: 'pending', meta: pendingMeta });
        await emitMessageUpdated(this.options, messageId);

        // Image generation is now detached from the reply. The message can be
        // marked sent immediately, while this same persisted part keeps polling.
        void finishDetachedJob({
          options: this.options,
          runtime,
          provider,
          messageId,
          partId: pendingPartId,
          prompt: imagePrompt,
          selfImage,
          clientRequestId,
          jobId: started.jobId,
          initialMeta: pendingMeta,
          signal: undefined
        });

        const visualOnly: EffectiveDirectives = {
          ...directives,
          imagePrompt: undefined,
          selfImagePrompt: undefined,
          requiredImage: false
        };
        const nonImage = await originalAppend.call(this, messageId, visualOnly, signal, context);
        return {
          ...nonImage,
          appended: nonImage.appended + 1,
          imageAttempted: true,
          imageFailed: false
        };
      } catch (error) {
        if (!(error instanceof ImageJobUnsupportedError)) {
          await failPendingPart(this.options, messageId, pendingPartId, pendingMeta, error);
          return { appended: 0, imageAttempted: true, imageFailed: true };
        }
        // Gateway not deployed yet. Keep today's synchronous generation as a
        // compatibility fallback, but retain the placeholder so the user can
        // finally see “图片生成中…” during that long request.
        pendingMeta = { ...pendingMeta, imageState: 'legacy' };
        await this.options.messages.updatePart(pendingPartId, { status: 'pending', meta: pendingMeta });
        await emitMessageUpdated(this.options, messageId);
      }
    }

    try {
      const current = await this.options.messages.get(messageId);
      const before = new Set<string>(current?.content.map((part) => part.id) ?? []);
      const result = await originalAppend.call(this, messageId, directives, signal, context);
      await reconcileLegacyImage(this.options, messageId, pendingPartId, before, pendingMeta);
      return result;
    } catch (error) {
      await this.options.messages.deletePart(pendingPartId).catch(() => undefined);
      await emitMessageUpdated(this.options, messageId);
      throw error;
    }
  };

  prototype.recover = async function (this: InternalCoordinator): Promise<void> {
    await originalRecover.call(this);
    const runtime = this.runtime();
    if (!runtime?.imageProvider) return;
    const provider = await runtime.imageProvider().catch(() => null);
    if (!provider?.configured || !isJobCapableImageProvider(provider)) return;
    const recent = await this.options.messages.recent(256).catch(() => [] as ChatMessage[]);
    for (const message of recent) {
      for (const part of message.content) {
        if (part.type !== 'image' || part.status !== 'pending' || activeRecoveredParts.has(part.id)) continue;
        let remoteJobId = cleanString(part.meta.remoteJobId);
        const clientRequestId = cleanString(part.meta.clientRequestId);
        if (!remoteJobId && !clientRequestId) continue;
        if (part.meta.imageState === 'legacy') {
          await failPendingPart(this.options, message.id, part.id, part.meta, new Error('上次图片生成在旧同步通道中断，请重新生成'));
          continue;
        }

        let recoveredMeta = { ...part.meta };
        const recoverPrompt = cleanString(part.meta.preparedPrompt) ?? cleanString(part.meta.prompt) ?? '';
        if (!remoteJobId && clientRequestId) {
          if (!recoverPrompt) {
            await failPendingPart(this.options, message.id, part.id, recoveredMeta, new Error('图片任务缺少可恢复的生成参数，请重新生成'));
            continue;
          }
          try {
            const references = await recoverImageReferences(runtime, recoveredMeta, recoverPrompt);
            const lifecycle = {
              clientRequestId,
              onState: async (state: ImageJobLifecycleState) => {
                recoveredMeta = {
                  ...recoveredMeta,
                  imageState: state.state,
                  ...(state.remoteJobId ? { remoteJobId: state.remoteJobId } : {}),
                  ...(state.error ? { jobError: state.error } : {})
                };
                await this.options.messages.updatePart(part.id, { status: 'pending', meta: recoveredMeta });
                await emitMessageUpdated(this.options, message.id);
              }
            };
            // startJob is intentionally idempotent by clientRequestId. A lost
            // POST response therefore becomes "return the existing job or create
            // it once" instead of a permanent recovery failure.
            const restarted = await provider.startJob(recoverPrompt, {
              ...(references.length ? { referenceImages: references } : {})
            }, lifecycle);
            remoteJobId = restarted.jobId;
            recoveredMeta = {
              ...recoveredMeta,
              imageState: 'queued',
              preparedPrompt: recoverPrompt,
              remoteJobId
            };
            await this.options.messages.updatePart(part.id, { status: 'pending', meta: recoveredMeta });
            await emitMessageUpdated(this.options, message.id);
          } catch (error) {
            await failPendingPart(this.options, message.id, part.id, recoveredMeta, error);
            continue;
          }
        }

        activeRecoveredParts.add(part.id);
        void finishDetachedJob({
          options: this.options,
          runtime,
          provider,
          messageId: message.id,
          partId: part.id,
          prompt: cleanString(part.meta.prompt) ?? recoverPrompt,
          selfImage: part.meta.selfImage === true,
          clientRequestId: clientRequestId ?? imageRequestId(),
          jobId: remoteJobId,
          initialMeta: recoveredMeta,
          signal: undefined
        }).finally(() => activeRecoveredParts.delete(part.id));
      }
    }
  };
}

async function prepareImageJob(
  coordinator: InternalCoordinator,
  runtime: ReplyFeatureRuntime,
  imagePrompt: string,
  selfImage: boolean,
  context: ImageContext,
  signal: AbortSignal
): Promise<{ prompt: string; references: Array<{ data: Uint8Array; mime: string }>; aspectRatio?: string; referenceMediaId?: string }> {
  const userImageParts = context.sourceMessages
    .filter((message) => message.role === 'user')
    .flatMap((message) => message.content.filter((part) => part.type === 'image' && part.mediaId).map((part) => part.mediaId!));
  const editingUserImage = userImageParts.length === 1;
  let finalPrompt = imagePrompt;
  let aspectRatio: string | undefined;

  if (!editingUserImage && coordinator.options.mediaDirector) {
    try {
      const expanded = await coordinator.options.mediaDirector.image({
        scene: imagePrompt.slice(0, 400),
        intent: selfImage ? 'selfie' : 'private snapshot'
      }, { signal });
      if (expanded.prompt.trim()) finalPrompt = expanded.prompt.trim();
      aspectRatio = expanded.aspectRatio;
    } catch (error) {
      if (signal.aborted) throw error;
      finalPrompt = fallbackImagePrompt({ scene: imagePrompt.slice(0, 400), intent: selfImage ? 'selfie' : 'private snapshot' });
    }
  }

  if (editingUserImage) {
    const referenceMediaId = userImageParts[0]!;
    const read = await runtime.media.read(referenceMediaId);
    if (!read) throw new Error('参考图不可用，请重新上传后再试');
    return {
      prompt: finalPrompt,
      references: [{ data: read.data instanceof Uint8Array ? read.data : new Uint8Array(read.data), mime: read.record.mime }],
      aspectRatio,
      referenceMediaId
    };
  }

  const references = selfImage ? await runtime.referenceImages?.(finalPrompt) ?? [] : [];
  return { prompt: finalPrompt, references, aspectRatio };
}

async function recoverImageReferences(
  runtime: ReplyFeatureRuntime,
  meta: Record<string, unknown>,
  prompt: string
): Promise<Array<{ data: Uint8Array; mime: string }>> {
  const referenceMediaId = cleanString(meta.referenceMediaId);
  if (referenceMediaId) {
    const read = await runtime.media.read(referenceMediaId);
    if (read) return [{ data: read.data instanceof Uint8Array ? read.data : new Uint8Array(read.data), mime: read.record.mime }];
  }
  if (meta.selfImage === true) return await runtime.referenceImages?.(prompt) ?? [];
  return [];
}

async function finishDetachedJob(input: {
  options: ReplyCoordinatorOptions;
  runtime: ReplyFeatureRuntime;
  provider: JobCapableImageProvider;
  messageId: string;
  partId: string;
  prompt: string;
  selfImage: boolean;
  clientRequestId: string;
  jobId?: string;
  initialMeta: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<void> {
  let meta = { ...input.initialMeta };
  try {
    const generated = await input.provider.resumeJob({ jobId: input.jobId, clientRequestId: input.clientRequestId }, {
      clientRequestId: input.clientRequestId,
      onState: async (state) => {
        meta = {
          ...meta,
          imageState: state.state,
          ...(state.remoteJobId ? { remoteJobId: state.remoteJobId } : {})
        };
        await input.options.messages.updatePart(input.partId, { status: 'pending', meta });
        await emitMessageUpdated(input.options, input.messageId);
      }
    }, input.signal);
    const record = await saveGenerated(input.runtime, generated, input.prompt, input.provider.name, input.selfImage);
    meta = { ...meta, imageState: 'succeeded', provider: input.provider.name, generated: true };
    await input.options.messages.updatePart(input.partId, { mediaId: record.id, status: 'sent', error: null, meta });
    await emitMessageUpdated(input.options, input.messageId);
    input.options.emit('reply.media.created', { messageId: input.messageId, type: 'image', mediaId: record.id, provider: input.provider.name, recovered: true });
  } catch (error) {
    await failPendingPart(input.options, input.messageId, input.partId, meta, error);
  }
}

async function saveGenerated(runtime: ReplyFeatureRuntime, generated: GeneratedImage, prompt: string, provider: string, selfImage: boolean) {
  return await runtime.media.save({
    kind: 'image',
    data: generated.data,
    mime: generated.mime,
    name: `sooya-${Date.now()}.image`,
    metadata: { prompt, provider, generated: true, selfImage }
  });
}

async function reconcileLegacyImage(
  options: ReplyCoordinatorOptions,
  messageId: string,
  pendingPartId: string,
  before: Set<string>,
  pendingMeta: Record<string, unknown>
): Promise<void> {
  const message = await options.messages.get(messageId);
  if (!message) return;
  const produced = message.content
    .filter((part) => part.type === 'image' && part.id !== pendingPartId && !before.has(part.id))
    .at(-1);
  if (!produced) {
    await failPendingPart(options, messageId, pendingPartId, pendingMeta, new Error('图片生成没有返回结果'));
    return;
  }
  await options.messages.updatePart(pendingPartId, {
    mediaId: produced.mediaId,
    status: produced.status,
    error: produced.error,
    meta: {
      ...pendingMeta,
      ...produced.meta,
      imageState: produced.status === 'sent' ? 'succeeded' : 'failed'
    }
  });
  await options.messages.deletePart(produced.id);
  await emitMessageUpdated(options, messageId);
}

async function failPendingPart(
  options: ReplyCoordinatorOptions,
  messageId: string,
  partId: string,
  meta: Record<string, unknown>,
  error: unknown
): Promise<void> {
  const message = safeError(error);
  await options.messages.updatePart(partId, {
    status: 'failed',
    error: message,
    meta: { ...meta, imageState: 'failed', jobError: message }
  }).catch(() => undefined);
  await emitMessageUpdated(options, messageId);
  options.emit('reply.media.failed', { messageId, type: 'image', error: message, durableJob: true });
}

async function emitMessageUpdated(options: ReplyCoordinatorOptions, messageId: string): Promise<void> {
  const message = await options.messages.get(messageId).catch(() => undefined);
  if (message) options.emit('message.updated', { message });
}

function imageRequestId(): string {
  try { return globalThis.crypto.randomUUID(); }
  catch { return `image-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+[^\s]+/giu, 'Bearer [REDACTED_SECRET]').slice(0, 500);
}

// Install on module evaluation. @sooya/core/app imports this file before native
// boot constructs LocalCore, so every on-device ReplyCoordinator gets the same
// durable behavior without changing browser/server fallback builds.
installReplyImageJobs();
