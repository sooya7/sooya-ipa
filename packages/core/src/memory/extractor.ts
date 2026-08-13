import type { ChatProvider } from '../providers/types.js';
import type { MemoryCandidate, MemoryCommitInput } from './types.js';

export interface MemoryExtractorOptions {
  provider?: ChatProvider | null | (() => Promise<ChatProvider | null>);
  maxCandidates?: number;
}

/** Model-first extraction with a deterministic, privacy-preserving fallback. */
export class MemoryExtractor {
  private readonly maxCandidates: number;

  constructor(private readonly options: MemoryExtractorOptions = {}) {
    this.maxCandidates = Math.max(1, Math.min(12, options.maxCandidates ?? 8));
  }

  async extract(input: MemoryCommitInput): Promise<MemoryCandidate[]> {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error('memory extraction aborted');
    const provider = typeof this.options.provider === 'function' ? await this.options.provider() : this.options.provider;
    if (provider?.configured) {
      try {
        const result = await provider.complete({
          system: '你是本地记忆抽取器。只返回 JSON，不要解释。只记录用户明确表达、未来有用且稳定的信息；不要记录一次性闲聊、敏感推断或模型自己的内容。JSON 格式为 {"memories":[{"kind":"profile|preference|relationship|project|event|summary","content":"...","importance":0到1,"confidence":0到1}]}。',
          messages: [{ role: 'user', content: [{ type: 'text', text: `用户：${input.userText}\n助手：${input.assistantText}` }] }],
          maxTokens: 700,
          temperature: 0,
          jsonMode: true,
          signal: input.signal
        });
        const parsed = parseCandidates(result.text, this.maxCandidates);
        if (parsed.length > 0 || looksLikeNoMemory(result.text)) return parsed;
      } catch {
        // The local fallback keeps the durable commit available when the model
        // is unavailable, times out, or returns malformed JSON.
      }
    }
    return fallbackCandidates(input.userText, this.maxCandidates);
  }
}

export function fallbackCandidates(text: string, maxCandidates = 8): MemoryCandidate[] {
  const normalized = text.replace(/[\r\n]+/gu, ' ').trim();
  if (!normalized || normalized.length > 500) return [];
  const candidates: MemoryCandidate[] = [];
  const remember = normalized.match(/(?:请)?(?:记住|别忘了|不要忘记)[：: ]*(.+)$/u)?.[1];
  if (remember) candidates.push({ kind: 'summary', content: remember.trim(), importance: 0.8, confidence: 0.8 });
  if (/^(?:我喜欢|我不喜欢|我偏好|我讨厌)/u.test(normalized)) candidates.push({ kind: 'preference', content: normalized, importance: 0.65, confidence: 0.7 });
  if (/^(?:我是|我叫|我的名字是|我住在|我在)/u.test(normalized)) candidates.push({ kind: 'profile', content: normalized, importance: 0.7, confidence: 0.72 });
  return candidates.slice(0, maxCandidates);
}

function parseCandidates(text: string, maxCandidates: number): MemoryCandidate[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  try {
    const value = JSON.parse(cleaned) as unknown;
    const rows = value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { memories?: unknown }).memories)
      ? (value as { memories: unknown[] }).memories : Array.isArray(value) ? value : [];
    return rows.flatMap((row) => {
      if (!row || typeof row !== 'object') return [];
      const item = row as Record<string, unknown>;
      const kind = item.kind;
      const content = typeof item.content === 'string' ? item.content.trim().slice(0, 500) : '';
      if (!content || !['profile', 'preference', 'relationship', 'project', 'event', 'summary'].includes(String(kind))) return [];
      return [{
        kind: kind as MemoryCandidate['kind'],
        content,
        importance: clamp(item.importance, 0.5),
        confidence: clamp(item.confidence, 0.6)
      }];
    }).slice(0, maxCandidates);
  } catch { return []; }
}

function looksLikeNoMemory(text: string): boolean { return /"memories"\s*:\s*\[\s*\]/u.test(text); }
function clamp(value: unknown, fallback: number): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback; }
