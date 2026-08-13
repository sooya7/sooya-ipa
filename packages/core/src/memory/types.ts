export type MemoryKind = 'profile' | 'preference' | 'relationship' | 'project' | 'event';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  content: string;
  normalized: string;
  importance: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  source: 'local' | 'mcp' | 'ombre-import' | string;
  sourceId?: string;
  sourceHash?: string;
  score?: number;
}

export interface MemoryRecallInput { query: string; limit?: number; signal?: AbortSignal; }
export interface MemoryRecall { entries: MemoryEntry[]; strategy: 'none' | 'fts' | 'embedding' | 'remote' | 'hybrid' | 'hybrid-degraded'; }
export interface MemoryCommitInput { batchId: string; revision: number; userText: string; assistantText: string; signal?: AbortSignal; }
export interface MemoryCommitResult { state: 'completed' | 'skipped' | 'uncertain'; inserted: number; merged: number; reason?: string; }
export interface MemoryCandidate { kind: MemoryKind; content: string; importance: number; confidence: number; expiresAt?: string | null; sourceHash?: string; }

export interface MemoryProvider {
  wake(signal?: AbortSignal): Promise<string | null>;
  recall(input: MemoryRecallInput): Promise<MemoryRecall>;
  commit(input: MemoryCommitInput): Promise<MemoryCommitResult>;
  search(query: string, limit?: number): Promise<MemoryEntry[]>;
  list(options?: { limit?: number; offset?: number; kind?: MemoryKind }): Promise<MemoryEntry[]>;
  update(id: string, patch: { content?: string; importance?: number; confidence?: number }): Promise<MemoryEntry | null>;
  forget(id: string): Promise<boolean>;
  maintain(signal?: AbortSignal): Promise<{ removed: number; reembedded: number }>;
  health(): Promise<{ state: 'ready' | 'degraded' | 'unavailable'; provider: string; detail?: string }>;
}
