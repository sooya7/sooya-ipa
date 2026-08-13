import type { MemoryEntry, MemoryProvider } from './types.js';

export type MemorySyncState = 'pending_push' | 'pending_pull' | 'synced' | 'conflict' | 'error';
export type MemorySyncOperation = 'upsert' | 'forget';

export interface MemorySyncStatus {
  state: 'ready' | 'degraded' | 'unavailable';
  provider: string;
  pendingPush: number;
  pendingPull: number;
  conflicts: number;
  lastSyncAt: string | null;
  detail?: string;
}

export interface MemorySyncResult {
  state: MemorySyncStatus['state'];
  pushed: number;
  pulled: number;
  conflicts: number;
  pending: number;
  detail?: string;
}

/** Optional coordinator used by the hybrid router. Local-only mode does not need it. */
export interface MemorySyncCoordinator {
  enqueueLocalChanges(limit?: number): Promise<void>;
  noteLocalUpdate(id: string): Promise<void>;
  noteLocalForget(id: string): Promise<void>;
  syncOnce(signal?: AbortSignal): Promise<MemorySyncResult>;
  status(): Promise<MemorySyncStatus>;
}

export interface OmbreMemorySyncPort {
  upsertEntry(entry: MemoryEntry, signal?: AbortSignal): Promise<MemoryEntry>;
  forgetRemote(id: string, signal?: AbortSignal): Promise<boolean>;
  pullChanges(cursor: string | null, limit?: number, signal?: AbortSignal): Promise<{ entries: MemoryEntry[]; nextCursor: string | null }>;
}

export type MemoryProviderFactory = MemoryProvider;
