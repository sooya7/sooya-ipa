import type { MessageRepo } from '../../db/message.repo.js';
import type { SettingsRepo } from '../../db/misc.repo.js';
import type { VoiceRepo } from '../../db/voice.repo.js';
import type { MediaPlatform } from '../../platform/media.js';
import type { TTSProvider } from '../../providers/types.js';
import type { ChatMessage } from '../types.js';
import type { MediaDirector, VoiceDirectorOptions } from '../media-director.js';
import { StaleGenerationError } from '../stale-generation.js';
import { DEFAULT_VOICE_EMOTIONS, resolveVoiceDelivery, type VoiceEmotionMap } from './emotion.js';
import { deliveryToTTSOptions, planDelivery } from './delivery.js';
import { fishCueForMood } from './fish-cue.js';
import { assessNaturalness, estimateSpeechSeconds, splitSentences } from './naturalness.js';
import { normalizeVoiceText, ruleBasedColloquial } from './normalize.js';
import { semanticRiskReport } from './semantic.js';
import { decideVoiceMode } from './planner.js';
import type { VoiceDecision, VoiceDecisionInput } from './planner.js';
import { DEFAULT_SPEECH_STYLE, stylePromptHints } from './style.js';
import type { PersonaSpeechStyle } from './style.js';
import type { UserVoicePreferences, VoiceMode, VoiceScript, VoicePartMeta } from './types.js';

export type { VoiceIntent } from './types.js';
export { parseVoiceIntent, mergeVoiceDirectives } from './intent.js';
export { decideVoiceMode } from './planner.js';
export type { VoiceDecision } from './planner.js';
export { DEFAULT_VOICE_PREFERENCES } from './types.js';

const MODE_PROMPT: Record<VoiceMode, string> = {
  replace: '语音承担完整回答，文字将不显示；要让对方只听语音就能完全明白。',
  complement: '文字已经提供了主要信息，语音只补充更适合用声音表达的关心、态度或温度；不要复述文字内容。',
  summary: '文字较长，语音用自然口语概括重点；保留主结论，不逐条念列表，不要省略关键提醒。',
  read_aloud: '按原文朗读，不改语义。'
};

export interface InlineVoiceArgs {
  batchId: string;
  revision: number;
  /** The assistant message once it exists; null for hidden-draft replace. */
  shell: ChatMessage | null;
  textPartId: string | null;
  finalText: string;
  userText: string;
  decision: VoiceDecision;
  modelEmotion: string | null;
  /** Intensity (0–1) from the model's voice marker, when the model expressed one. */
  modelIntensity?: number | null;
  signal: AbortSignal;
  /** Media platform + TTS provider resolved from the feature runtime per call. */
  media: MediaPlatform;
  ttsProvider: TTSProvider;
  /**
   * Hidden-draft replace: the shell is created only after TTS (or the text
   * fallback) is ready, so no empty bubble and no visible text ever existed.
   */
  openShell?: () => ChatMessage | Promise<ChatMessage>;
}

/** Explicit publication outcome — the coordinator never has to guess. */
export type InlineVoiceOutcome =
  | { kind: 'published'; mode: VoiceMode; mediaId: string; partId: string; shellId: string }
  | { kind: 'published-as-text'; reason: string; shellId: string; text: string }
  | { kind: 'skipped'; reason: string };
// Aborts / revision-fence losses are NOT outcomes: they throw (the shared
// StaleGenerationError or the abort reason) so the reply takes its
// superseded path instead of provider_failed.

export interface LocalVoiceServiceDeps {
  voices: VoiceRepo;
  settings: SettingsRepo;
  messages: MessageRepo;
  mediaDirector: MediaDirector;
  /** Persona voice policy resolver (defaults applied by the caller). */
  persona: () => { name: string; voicePolicy: { enabled: boolean; maxCharsPerClip: number } } | Promise<{ name: string; voicePolicy: { enabled: boolean; maxCharsPerClip: number } }>;
  emit: (type: string, data: Record<string, unknown>) => void;
  isCurrentRevision: (batchId: string, revision: number) => Promise<boolean>;
  now?: () => Date;
}

/**
 * Voice expression service (server parity, Part 4): intent → mode → spoken
 * script → naturalness guard → semantic guard → delivery plan → TTS →
 * publication, with per-mode fallbacks and full revision/abort discipline.
 *
 * LocalCore adaptations from the server version:
 * - No MetricsService / CapabilityRegistry / EventBus / ErrorLogRepo: the
 *   emit callback carries privacy-safe voice.* events.
 * - ttsProvider/media are resolved by the caller per call from the feature
 *   runtime seam, keeping this service free of Capacitor knowledge.
 * - Generation providers are NEVER auto-retried (费用与幂等约束, §11.5).
 * - Guard outcomes follow the parity doc §18 more strictly than the server
 *   code: a director fallback marks the script absent, so complement/summary
 *   skip the voice instead of reading a degraded script.
 */
export class LocalVoiceService {
  constructor(private readonly deps: LocalVoiceServiceDeps) {}

  get preferences(): Promise<UserVoicePreferences> {
    // Bridge the legacy {enabled, maxVoiceSeconds} admin shape onto the
    // server preference model; everything else keeps stable defaults with
    // auto voice pinned off until parity stabilizes.
    return this.deps.settings.get<{ enabled: boolean; maxVoiceSeconds: number }>('voiceBehavior', { enabled: true, maxVoiceSeconds: 30 }).then((behavior) => ({
      enabled: behavior.enabled !== false,
      autoVoiceFrequency: 'never' as const,
      preferredModes: ['replace', 'complement'] as VoiceMode[],
      maxVoiceSeconds: Math.max(5, Math.min(120, Number(behavior.maxVoiceSeconds) || 30)),
      autoplay: false,
      showTranscript: 'collapsed' as const
    }));
  }

  get speechStyle(): Promise<PersonaSpeechStyle> {
    return this.deps.settings.get<PersonaSpeechStyle>('voice.speechStyle', DEFAULT_SPEECH_STYLE);
  }

  /** Planner wrapper: resolves persona/preferences/tts into a VoiceDecision. */
  async decide(input: { userIntent: VoiceDecisionInput['userIntent']; modelVoice: VoiceDecisionInput['modelVoice']; text: string; ttsConfigured: boolean }): Promise<VoiceDecision> {
    const [preferences, persona] = await Promise.all([this.preferences, this.deps.persona()]);
    return decideVoiceMode({
      userIntent: input.userIntent,
      modelVoice: input.modelVoice,
      text: input.text,
      persona,
      preferences,
      ttsConfigured: input.ttsConfigured,
      recentAutoCount: 0,
      dailyAutoCap: 0, // auto path is unreachable while autoVoiceFrequency is 'never'
      inSilentHours: false
    });
  }

  /** Full inline voice flow; never throws for provider failures (falls back
   * per mode) — aborts and stale revisions propagate as throws. */
  async synthesizeInlineVoice(args: InlineVoiceArgs): Promise<InlineVoiceOutcome> {
    const { decision, signal, ttsProvider } = args;
    const mode = decision.mode;
    if (!mode) return { kind: 'skipped', reason: 'voice:no-mode' };
    const [style, persona] = await Promise.all([this.speechStyle, this.deps.persona()]);
    const maxSeconds = style.maxVoiceSeconds || persona.voicePolicy.maxCharsPerClip / 8;
    const maxChars = persona.voicePolicy.maxCharsPerClip;

    // 1. Script.
    let script: VoiceScript | null = null;
    if (mode === 'read_aloud') {
      script = {
        spokenText: args.finalText,
        mode: 'read_aloud',
        purpose: 'read_aloud',
        estimatedSeconds: estimateSpeechSeconds(args.finalText),
        semanticClaims: [],
        styleTags: ['read-aloud']
      };
    } else {
      script = await this.generateScript(args, mode, maxSeconds, signal, 0);
      if (script && !this.guardAccepts(script, args.finalText, mode, maxSeconds)) {
        const report = assessNaturalness(script.spokenText, args.finalText, mode, { maxVoiceSeconds: maxSeconds });
        // One rewrite with the report.
        script = await this.generateScript(args, mode, maxSeconds, signal, 1, report.reasons);
        if (script && !this.guardAccepts(script, args.finalText, mode, maxSeconds)) {
          // Doc §18: complement/summary skip the voice; replace degrades to
          // the canonical text (never a trimmed fake of the full answer).
          if (mode === 'replace') {
            script = this.degradeScript(script, args.finalText, mode, maxChars);
          } else {
            this.emitEvent('voice.script.rejected', { batchId: args.batchId, revision: args.revision, mode, reasons: report.reasons });
            return { kind: 'skipped', reason: 'voice:skipped-naturalness' };
          }
        }
      }
      if (!script) {
        if (mode === 'replace') {
          const fallback = ruleBasedColloquial(args.finalText, maxChars);
          script = { spokenText: fallback, mode: 'replace', purpose: 'full_answer', estimatedSeconds: estimateSpeechSeconds(fallback), semanticClaims: [], styleTags: ['rule-fallback'] };
        } else {
          return { kind: 'skipped', reason: 'voice:no-script' };
        }
      }
    }

    // 2. Normalize: the stored transcript is what was actually spoken; the
    // synthesis text is its pronunciation-normalized form.
    let { spokenText, synthesisText } = normalizeVoiceText(script.spokenText);
    if (!spokenText.trim()) return { kind: 'skipped', reason: 'voice:empty-script' };

    // 3. Semantic guard: the script must not ADD high-risk facts the reply
    // never stated. complement/summary may be dropped, replace falls back to
    // the canonical text.
    if (mode !== 'read_aloud') {
      const report = semanticRiskReport(synthesisText, args.finalText);
      if (!report.ok) {
        if (mode === 'summary') {
          script = await this.generateScript(args, mode, maxSeconds, signal, 2, report.risks.map((r) => `新增了正文没有的事实：${r}`).concat('不要新增任何正文没有的数字、时间、金额或承诺'));
          if (script) ({ spokenText, synthesisText } = normalizeVoiceText(script.spokenText));
        }
        if (semanticRiskReport(synthesisText, args.finalText).ok) {
          // rewrite fixed it
        } else if (mode === 'replace') {
          return await this.publishReplaceTextFallback(args, args.finalText, 'semantic_risk');
        } else {
          return { kind: 'skipped', reason: 'voice:semantic-risk' };
        }
      }
    }

    // 4. Length policy: never ship truncated audio that pretends to be the
    // full answer. replace compacts once then falls back to full text;
    // complement may shorten at whole-sentence boundaries; summary is bounded
    // at generation and dropped rather than clipped; read_aloud reads as-is.
    let clipped = false;
    if (synthesisText.length > maxChars) {
      if (mode === 'replace') {
        if (script && !script.styleTags.includes('rule-fallback')) {
          const compact = await this.generateScript(args, mode, maxSeconds, signal, 2, ['更短：当前脚本超过语音时长上限，压缩到核心内容，保留所有关键事实，不要逐条展开']);
          if (compact) ({ spokenText, synthesisText } = normalizeVoiceText(compact.spokenText));
        }
        if (synthesisText.length > maxChars) {
          return await this.publishReplaceTextFallback(args, args.finalText, 'too_long');
        }
      } else if (mode === 'complement') {
        const sentences = splitSentences(synthesisText);
        const kept: string[] = [];
        let length = 0;
        for (const sentence of sentences) {
          if (length + sentence.length > maxChars) break;
          kept.push(sentence);
          length += sentence.length;
        }
        if (kept.length === 0 || length < Math.min(maxChars, synthesisText.length) * 0.5) {
          return { kind: 'skipped', reason: 'voice:too-long' };
        }
        spokenText = kept.join('');
        synthesisText = kept.join('');
        clipped = true;
      } else if (mode === 'summary') {
        return { kind: 'skipped', reason: 'voice:too-long' };
      }
    }

    // 5. Delivery. Explicit emotion wins; otherwise detect it from the reply
    // text through the saved mapping, like the legacy read-back path did.
    const emotions = await this.deps.settings.get<VoiceEmotionMap>('voice.emotions', DEFAULT_VOICE_EMOTIONS);
    const emotion = decision.emotion ?? args.modelEmotion ?? resolveVoiceDelivery(args.finalText, null, emotions).emotion;
    const delivery = planDelivery(emotion, script?.directorSpeed ? { pace: script.directorSpeed } : {});
    // Fish path: the cue + speed are compiled ONCE here, with the real model
    // intensity; custom presets never reach Fish; OpenAI/Volc keep delivery
    // options. No second emotion guess inside the provider.
    const fishSynthesis = ttsProvider.name === 'fish'
      ? this.compileFishSynthesis(synthesisText, { emotion, intensity: args.modelIntensity, directorSpeed: script?.directorSpeed })
      : null;
    const ttsOptions = fishSynthesis
      ? { emotion: delivery.primaryEmotion, speed: fishSynthesis.speed }
      : deliveryToTTSOptions(delivery, emotions, { advanced: true });

    // 6. Generation record.
    const generation = await this.deps.voices.create({
      batchId: args.batchId,
      revision: args.revision,
      messageId: args.shell?.id ?? null,
      textPartId: args.textPartId,
      mode,
      requestedBy: decision.requestedBy,
      status: 'scripted',
      spokenText,
      synthesisText,
      delivery: delivery as unknown as Record<string, unknown>,
      naturalness: { accepted: true },
      provider: ttsProvider.name
    });
    this.emitEvent('voice.script.completed', { voiceGenerationId: generation.id, batchId: args.batchId, revision: args.revision, messageId: args.shell?.id ?? null, mode, status: 'scripted' });

    // 7. Synthesize (single attempt — generation providers never auto-retry).
    try {
      await this.deps.voices.update(generation.id, { status: 'synthesizing', started_at: (this.deps.now?.() ?? new Date()).toISOString() });
      this.emitEvent('voice.synthesis.started', { voiceGenerationId: generation.id, batchId: args.batchId, revision: args.revision, messageId: args.shell?.id ?? null, mode, status: 'synthesizing' });
      if (signal.aborted) throw signal.reason ?? new Error('voice aborted');
      const audio = await ttsProvider.synthesize(fishSynthesis?.text ?? synthesisText, { ...ttsOptions, signal });
      // Re-check the revision fence before any persistence: a stale synthesis
      // must never attach audio to a reply it no longer belongs to.
      if (signal.aborted || !(await this.deps.isCurrentRevision(args.batchId, args.revision))) {
        await this.markSuperseded(generation.id, args, mode);
        throw new StaleGenerationError('voice revision stale before media.save');
      }
      const media = await args.media.save({
        kind: 'audio',
        data: audio.data,
        mime: audio.mime,
        name: `sooya-voice-${Date.now()}.${audio.format}`,
        transcript: spokenText,
        metadata: { provider: ttsProvider.name, generated: true, tts: true, voiceMode: mode, requestedBy: decision.requestedBy }
      });
      if (signal.aborted || !(await this.deps.isCurrentRevision(args.batchId, args.revision))) {
        await args.media.destroy?.(media.id).catch(() => undefined);
        await this.markSuperseded(generation.id, args, mode);
        throw new StaleGenerationError('voice revision stale before publish');
      }

      // 8. Publish per mode.
      const meta: VoicePartMeta = {
        voiceMode: mode,
        requestedBy: decision.requestedBy,
        emotion: delivery.primaryEmotion,
        pace: delivery.pace,
        generatedFromTextPartId: args.textPartId,
        targetMessageId: null,
        synthesisChars: synthesisText.length,
        fullTranscriptAvailable: true,
        voiceGenerationId: generation.id,
        ...(clipped ? { clipped: true, spokenChars: synthesisText.length } : {})
      };
      let partId: string | null = null;
      let targetShell = args.shell;
      if (!targetShell && args.openShell) {
        // Hidden draft: open the barrier and create the shell only now that
        // the audio (or its text fallback) is ready.
        targetShell = await args.openShell();
      }
      if (!targetShell) throw new StaleGenerationError('voice publish target shell missing');
      if (mode === 'read_aloud' && args.textPartId) {
        // Attach to the existing text part; no new bubble.
        const part = targetShell.content.find((item) => item.id === args.textPartId);
        await this.deps.messages.updatePart(args.textPartId, { meta: { ...(part?.meta ?? {}), readAloudMediaId: media.id, readAloudDuration: audio.durationSec ? Math.round(audio.durationSec) : null } });
        partId = args.textPartId;
      } else {
        if (mode === 'replace' && args.textPartId) {
          // Remove the superseded draft text: the transcript is the copy.
          await this.deps.messages.deletePart(args.textPartId);
        }
        partId = await this.deps.messages.appendPart(targetShell.id, {
          type: 'audio',
          mediaId: media.id,
          status: 'sent',
          duration: audio.durationSec ? Math.round(audio.durationSec) : null,
          transcript: spokenText,
          meta: { ...meta }
        });
      }
      await this.deps.voices.update(generation.id, { status: 'published', media_id: media.id, message_id: targetShell.id, text_part_id: partId ?? args.textPartId ?? null, completed_at: (this.deps.now?.() ?? new Date()).toISOString() });
      this.emitEvent('voice.published', { voiceGenerationId: generation.id, batchId: args.batchId, revision: args.revision, messageId: targetShell.id, mode, status: 'published', mediaId: media.id, partId });
      return { kind: 'published', mode, mediaId: media.id, partId: partId ?? '', shellId: targetShell.id };
    } catch (error) {
      if (signal.aborted || error instanceof StaleGenerationError) throw error;
      return await this.handleSynthesisFailure(generation.id, mode, args, spokenText, error);
    }
  }

  private async generateScript(
    args: InlineVoiceArgs,
    mode: VoiceMode,
    maxSeconds: number,
    signal: AbortSignal,
    attempt: number,
    reportReasons?: string[]
  ): Promise<VoiceScript | null> {
    if (attempt > 0) this.emitEvent('voice.script.rewrite', { batchId: args.batchId, revision: args.revision, mode, attempt });
    const spokenBase = args.finalText.trim();
    if (mode === 'read_aloud') {
      return {
        spokenText: spokenBase,
        mode,
        purpose: 'full_answer',
        estimatedSeconds: estimateSpeechSeconds(spokenBase),
        semanticClaims: [],
        styleTags: ['read-aloud']
      };
    }
    const opts: VoiceDirectorOptions = {
      signal,
      mode: MODE_PROMPT[mode],
      userText: args.userText,
      maxSeconds,
      styleHints: stylePromptHints(DEFAULT_SPEECH_STYLE),
      reportReasons: attempt > 0 ? reportReasons : undefined
    };
    const result = await this.deps.mediaDirector.voice({ content: spokenBase }, opts);
    if (result.fallback) {
      // The director was unavailable/invalid: per doc §18 complement and
      // summary skip the voice rather than read a fallback script.
      return null;
    }
    const spoken = result.text.trim();
    if (!spoken) return null;
    return {
      spokenText: spoken,
      mode,
      purpose: mode === 'replace' ? 'full_answer' : mode === 'summary' ? 'short_summary' : 'emotional_support',
      estimatedSeconds: estimateSpeechSeconds(spoken),
      semanticClaims: [],
      styleTags: [],
      directorSpeed: result.speed !== 1 ? result.speed : undefined
    };
  }

  private guardAccepts(script: VoiceScript, text: string, mode: VoiceMode, maxSeconds: number): boolean {
    if (mode === 'read_aloud') return true;
    return assessNaturalness(script.spokenText, text, mode, { maxVoiceSeconds: maxSeconds }).accepted;
  }

  /** Replace degrade: the transcript is the user's only copy, so it must be
   * the canonical text — never a trimmed fake of the full answer. */
  private degradeScript(script: VoiceScript, text: string, mode: VoiceMode, _maxChars: number): VoiceScript | null {
    const candidate = mode === 'replace' ? text.trim() : ruleBasedColloquial(script.spokenText, _maxChars);
    if (!candidate.trim()) return null;
    return {
      spokenText: candidate,
      mode,
      purpose: mode === 'summary' ? 'short_summary' : 'full_answer',
      estimatedSeconds: estimateSpeechSeconds(candidate),
      semanticClaims: [],
      styleTags: ['rule-degraded']
    };
  }

  /** The ONLY compile point for a Fish cue (provider name gate in the caller). */
  private compileFishSynthesis(
    synthesisText: string,
    opts: { emotion: string | null; intensity?: number | null; directorSpeed?: number | null }
  ): { text: string; speed: number } {
    const rawEmotion = opts.emotion?.trim() || 'neutral';
    // Restraint first: without a real intensity the cue follows the utterance
    // mood — a plain neutral statement stays cue-free.
    const intensity = opts.intensity ?? (rawEmotion === 'neutral' ? 0 : 1);
    const spec = fishCueForMood(rawEmotion, {
      intensity,
      moodAlias: rawEmotion,
      directorSpeed: opts.directorSpeed ?? undefined,
      fallbackSpeed: 1
    });
    return {
      text: spec.cue ? `${spec.cue} ${synthesisText}` : synthesisText,
      speed: spec.speed
    };
  }

  /** replace can never ship truncated audio: publish the canonical text. */
  private async publishReplaceTextFallback(args: InlineVoiceArgs, fallbackText: string, reason: string): Promise<InlineVoiceOutcome> {
    const text = (fallbackText ?? '').trim();
    let targetShell = args.shell;
    if (!targetShell && args.openShell) targetShell = await args.openShell();
    if (!targetShell) return { kind: 'skipped', reason: 'voice:publish-target-missing' };
    if (args.textPartId) {
      await this.deps.messages.updatePart(args.textPartId, { text, status: 'sent', meta: { voiceFallback: true, voiceMode: 'replace', voiceFallbackReason: reason } });
    } else {
      await this.deps.messages.appendPart(targetShell.id, { type: 'text', text, status: 'sent', meta: { voiceFallback: true, voiceMode: 'replace', voiceFallbackReason: reason } });
    }
    this.emitEvent('voice.published', { voiceGenerationId: null, batchId: args.batchId, revision: args.revision, messageId: targetShell.id, mode: 'replace', status: 'published-as-text', reason });
    return { kind: 'published-as-text', reason, shellId: targetShell.id, text };
  }

  private async handleSynthesisFailure(
    generationId: string,
    mode: VoiceMode,
    args: InlineVoiceArgs,
    spokenText: string,
    error: unknown
  ): Promise<InlineVoiceOutcome> {
    const failureCode = 'tts_failed';
    await this.deps.voices.update(generationId, { status: 'failed', failed_at: (this.deps.now?.() ?? new Date()).toISOString(), failure_code: failureCode });
    this.emitEvent('voice.synthesis.failed', { voiceGenerationId: generationId, batchId: args.batchId, revision: args.revision, messageId: args.shell?.id ?? null, mode, status: 'failed', failureCode, error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) });
    if (mode === 'replace') {
      // Never lose content: publish the spoken script (or the fuller reply)
      // as plain text — for a hidden draft this is the first visible output.
      const script = spokenText.trim();
      const final = (args.finalText ?? '').trim();
      const fallbackText = script.length >= final.length ? script : final || script;
      let targetShell = args.shell;
      if (!targetShell && args.openShell) targetShell = await args.openShell();
      if (!targetShell) return { kind: 'skipped', reason: 'voice:publish-target-missing' };
      if (args.textPartId) {
        await this.deps.messages.updatePart(args.textPartId, { text: fallbackText, status: 'sent', meta: { voiceFallback: true, voiceMode: 'replace' } });
      } else {
        await this.deps.messages.appendPart(targetShell.id, { type: 'text', text: fallbackText, status: 'sent', meta: { voiceFallback: true, voiceMode: 'replace' } });
      }
      await this.deps.voices.update(generationId, { message_id: targetShell.id });
      this.emitEvent('voice.published', { voiceGenerationId: generationId, batchId: args.batchId, revision: args.revision, messageId: targetShell.id, mode, status: 'published-as-text' });
      return { kind: 'published-as-text', reason: 'audio:provider_unavailable', shellId: targetShell.id, text: fallbackText };
    }
    // complement / summary / read_aloud: the text reply stands on its own.
    return { kind: 'skipped', reason: 'audio:provider_unavailable' };
  }

  private async markSuperseded(generationId: string, args: InlineVoiceArgs, mode: VoiceMode): Promise<void> {
    await this.deps.voices.update(generationId, { status: 'superseded', failed_at: (this.deps.now?.() ?? new Date()).toISOString(), failure_code: 'superseded' });
    this.emitEvent('voice.generation.superseded', { voiceGenerationId: generationId, batchId: args.batchId, revision: args.revision, messageId: args.shell?.id ?? null, mode, status: 'superseded' });
  }

  private emitEvent(type: string, data: Record<string, unknown>): void {
    this.deps.emit(type, data);
  }
}
