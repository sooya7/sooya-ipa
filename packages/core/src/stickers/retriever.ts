import type { Sticker, StickerListOptions } from '../db/sticker.repo.js';
import type { StickerRetrieval } from './types.js';

export interface StickerRetrieverOptions {
  searchFts(query: string, options?: StickerListOptions): Promise<Sticker[]>;
  list(options?: StickerListOptions): Promise<Sticker[]>;
  /** Optional query-embedding resolver. Failure always falls back to FTS. */
  embedQuery?(text: string): Promise<number[] | null>;
  recentUsedIds?: string[];
  topK?: number;
}

export class StickerRetriever {
  private readonly topK: number;

  constructor(private readonly options: StickerRetrieverOptions) {
    this.topK = Math.max(1, Math.min(50, Math.trunc(options.topK ?? 12)));
  }

  async retrieve(input: { query: string; desiredIntent?: string; recentUsedIds?: string[] }): Promise<StickerRetrieval> {
    const query = input.query.trim().slice(0, 200);
    const recent = new Set(input.recentUsedIds ?? this.options.recentUsedIds ?? []);
    const [fts, popular] = await Promise.all([
      query ? this.options.searchFts(query, { enabledOnly: true, limit: 24 }).catch(() => []) : Promise.resolve([]),
      this.options.list({ enabledOnly: true, sort: 'usage', limit: 40 }).catch(() => [])
    ]);
    const byId = new Map<string, Sticker>();
    for (const sticker of [...fts, ...popular]) byId.set(sticker.id, sticker);
    let pool = [...byId.values()];
    if (pool.some((sticker) => !recent.has(sticker.id))) {
      pool = pool.filter((sticker) => !recent.has(sticker.id));
    }

    const queryVector = query ? await this.options.embedQuery?.(query).catch(() => null) ?? null : null;
    const scored = pool.map((sticker) => ({
      sticker,
      ...scoreSticker(sticker, { query, desiredIntent: input.desiredIntent, queryVector })
    }));
    scored.sort((a, b) => b.score - a.score || Number(b.sticker.favorite) - Number(a.sticker.favorite) || b.sticker.useCount - a.sticker.useCount);

    const candidates = scored.slice(0, this.topK);
    return {
      candidates,
      query,
      usedEmbedding: queryVector !== null,
      ftsCount: fts.length,
      semanticCount: pool.length
    };
  }
}

export interface StickerScoreInput {
  query: string;
  desiredIntent?: string;
  queryVector?: number[] | null;
}

export function scoreSticker(sticker: Sticker, input: StickerScoreInput): { score: number; signals: string[] } {
  const query = normalize(input.query);
  const signals: string[] = [];
  let score = 0;

  if (!query) {
    score += Math.min(0.45, sticker.useCount / 20);
    if (sticker.favorite) { score += 0.12; signals.push('favorite'); }
    return { score, signals };
  }

  const fields = [
    { name: 'userMeaning', text: sticker.userMeaning, weight: 0.5 },
    { name: 'imageText', text: sticker.imageText, weight: 0.22 },
    { name: 'description', text: sticker.description, weight: 0.2 },
    { name: 'name', text: sticker.name, weight: 0.16 },
    { name: 'emotion', text: sticker.emotion, weight: 0.12 }
  ] as const;
  for (const field of fields) {
    if (!field.text) continue;
    const similarity = lexicalSimilarity(query, normalize(field.text));
    if (similarity <= 0) continue;
    score += similarity * field.weight * 1.6;
    if (similarity > 0.55) signals.push(field.name);
  }
  for (const tag of sticker.tags) {
    score += Math.min(0.16, lexicalSimilarity(query, normalize(tag)) * 0.4);
  }

  if (sticker.favorite) { score += 0.08; signals.push('favorite'); }
  score += Math.min(0.15, (sticker.userUseCount + sticker.assistantUseCount) / 40);
  if (input.desiredIntent && sticker.emotion === input.desiredIntent) {
    score += 0.12;
    signals.push('emotion');
  }
  if (input.queryVector?.length && sticker.embedding?.length) {
    const similarity = cosineSimilarity(input.queryVector, embeddingVector(sticker.embedding));
    if (similarity > 0) {
      score += similarity * 0.35;
      signals.push('embedding');
    }
  }
  return { score, signals };
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\u3000\p{P}\p{S}]+/gu, '');
}

function lexicalSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.9;
  const a = bigrams(left);
  const b = bigrams(right);
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) if (large.has(value)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function bigrams(value: string): Set<string> {
  const chars = Array.from(value);
  const result = new Set<string>();
  for (let index = 0; index < chars.length - 1; index += 1) result.add(`${chars[index]}${chars[index + 1]}`);
  return result;
}

function embeddingVector(bytes: Uint8Array): number[] {
  if (bytes.byteLength % 4 === 0) {
    try { return Array.from(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))); } catch { /* fall through */ }
  }
  return [];
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}
