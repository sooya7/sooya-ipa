export interface LexicalDedupeItem<T = unknown> {
  id: string;
  text: string;
  /** Higher priority wins; lower-priority near-duplicates are dropped. */
  priority: number;
  kind: 'persona' | 'recent' | 'summary' | 'memory';
  value?: T;
}

export interface LexicalDedupeResult<T = unknown> {
  accepted: LexicalDedupeItem<T>[];
  dropped: LexicalDedupeItem<T>[];
}

export interface LexicalDedupeOptions {
  /** Bigram Jaccard threshold above which two items count as duplicates. */
  threshold?: number;
}

/**
 * Lightweight lexical cross-source dedupe. No embeddings and no full-content
 * logging: only normalized character bigrams are compared in memory.
 * Current-batch content must never be passed in here (batch is non-droppable).
 */
export function dedupeLexical<T = unknown>(
  items: LexicalDedupeItem<T>[],
  options: LexicalDedupeOptions = {}
): LexicalDedupeResult<T> {
  const threshold = options.threshold ?? 0.86;
  const accepted: LexicalDedupeItem<T>[] = [];
  const dropped: LexicalDedupeItem<T>[] = [];
  const acceptedSignatures = new Set<string>();
  const acceptedShingles: Array<{ item: LexicalDedupeItem<T>; shingles: Set<string> }> = [];

  const ordered = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.priority - a.item.priority || a.index - b.index);

  for (const { item } of ordered) {
    const normalized = normalizeLexical(item.text);
    if (!normalized) {
      dropped.push(item);
      continue;
    }
    const signature = normalized;
    if (acceptedSignatures.has(signature)) {
      dropped.push(item);
      continue;
    }
    const shingles = lexicalShingles(normalized);
    const duplicate = acceptedShingles.some((candidate) => {
      if (candidate.item.kind === item.kind && candidate.item.id === item.id) return false;
      return shingleSimilarity(shingles, candidate.shingles) >= threshold;
    });
    if (duplicate) {
      dropped.push(item);
      continue;
    }
    acceptedSignatures.add(signature);
    acceptedShingles.push({ item, shingles });
    accepted.push(item);
  }

  return { accepted, dropped };
}

function normalizeLexical(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\s\u3000\p{P}\p{S}]+/gu, '');
}

function lexicalShingles(normalized: string): Set<string> {
  const chars = Array.from(normalized);
  const shingles = new Set<string>();
  if (chars.length === 1) {
    shingles.add(chars[0]!);
    return shingles;
  }
  for (let index = 0; index < chars.length - 1; index += 1) {
    shingles.add(`${chars[index]}${chars[index + 1]}`);
  }
  return shingles;
}

function shingleSimilarity(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const shingle of small) if (large.has(shingle)) intersection += 1;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
