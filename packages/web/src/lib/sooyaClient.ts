import type { BootstrapInfo, MessageContext, MessageSearchHit, Moment } from './api.js';
import type { ChatMessage, MediaRef, StickerInfo, WorldPresence } from './types.js';
import type { LocalEventListener } from '../local/LocalEventBus.js';
import type { LocalCoreApi, UploadInputFile } from '@sooya/core/app';

export interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
  nextSince?: number;
  lastEventSeq: number;
  lastMessageSeq: number;
  oldestSeq: number | null;
}

export interface SooyaClient {
  bootstrap(): Promise<BootstrapInfo>;
  messages(options?: { limit?: number; before?: number; since?: number }): Promise<MessagePage>;
  messageSearch(query: string, options?: { limit?: number; cursor?: string | null }): Promise<{ hits: MessageSearchHit[]; nextCursor: string | null }>;
  messagesByDate(date: string, timeZone: string, limit?: number): Promise<{ date: string; timeZone: string; messages: ChatMessage[]; hasMore: boolean }>;
  messageContext(id: string, options?: { before?: number; after?: number }): Promise<MessageContext>;
  send(payload: { clientMsgId: string; content: unknown[]; directives?: Record<string, boolean>; replyTo?: string }): Promise<{ message: ChatMessage; duplicate: boolean; replyPending: boolean }>;
  withdraw(id: string): Promise<{ message: ChatMessage }>;
  retryBatch(id: string): Promise<{ batchId: string; revision: number; status: string }>;
  upload(files: Array<{ file: File | Blob; field: 'image' | 'file'; name?: string }>, options?: { signal?: AbortSignal }): Promise<{ media: MediaRef[]; failed: Array<{ filename: string; error: string; code?: string }> }>;
  moments(limit?: number): Promise<{ moments: Moment[]; hasMore: boolean }>;
  likeMoment(id: string, liked: boolean): Promise<{ moment: Moment }>;
  stickerSearch(options?: { scope?: 'recent' | 'favorite' | 'all'; q?: string; limit?: number; cursor?: string | null }): Promise<{ stickers: StickerInfo[]; total: number; nextCursor: string | null }>;
  life(): Promise<{ activity: string; kind: string; mood: string; startedAt: string; endsAt: string; recent: Array<{ activity: string; startedAt: string; endedAt: string }> }>;
  presence(): Promise<WorldPresence>;
  capabilities(): Promise<{ capabilities: Record<string, { configured: boolean; ok: boolean; detail?: string }>; stickers: { available: number; total: number } }>;
  adminRequest?<T = unknown>(path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T>;
  resolveBuiltinMediaUrl?(id: string): string | null;
  subscribe(listener: LocalEventListener): () => void;
}

/** Contract the in-process LocalCore exposes to the React client. */
export type LocalCoreFacade = LocalCoreApi;

let activeClient: SooyaClient | null = null;

/** Installed once during native bootstrap; browser/PWA keeps using the remote adapter. */
export function installSooyaClient(client: SooyaClient): void { activeClient = client; }
export function currentSooyaClient(): SooyaClient | null { return activeClient; }
export function clearSooyaClient(): void { activeClient = null; }

/** Converts DOM File/Blob uploads into the byte form LocalCore consumes. */
export async function toUploadInput(files: Array<{ file: File | Blob; field: 'image' | 'file'; name?: string }>): Promise<UploadInputFile[]> {
  return await Promise.all(files.map(async (file) => ({
    name: file.name ?? (file.file instanceof File ? file.file.name : 'upload'),
    mime: file.file.type || 'application/octet-stream',
    bytes: new Uint8Array(await file.file.arrayBuffer()),
    field: file.field
  })));
}
