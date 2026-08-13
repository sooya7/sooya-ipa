/**
 * Client-facing contract implemented by LocalCore and consumed by the React
 * shell (LocalSooyaClient). DTO shapes intentionally mirror the server-era
 * REST payloads so the UI event/data handling keeps working unchanged.
 * This module is dependency-free: Core never imports web packages.
 */

export interface LocalEvent<T extends Record<string, unknown> = Record<string, unknown>> {
  seq: number;
  type: string;
  data: T;
  createdAt: string;
}

export type LocalEventListener = (event: LocalEvent) => void;

export type Role = 'user' | 'assistant' | 'system';
export type MessageStatus = 'pending' | 'sending' | 'sent' | 'failed';
export type PartType = 'text' | 'sticker' | 'image' | 'audio' | 'file' | 'system';
export type WeatherCondition = 'clear' | 'cloudy' | 'rain' | 'snow' | 'storm' | 'fog' | 'wind' | 'unknown';

export interface MediaRef {
  id: string;
  kind: 'image' | 'audio' | 'sticker' | 'file';
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  url: string;
  name: string | null;
  transcript: string | null;
  animated: boolean;
  textStatus?: 'pending' | 'failed' | 'ready' | 'unsupported';
  textError?: string | null;
}

export interface MessagePart {
  id: string;
  type: PartType;
  text: string | null;
  mediaId: string | null;
  status: 'pending' | 'sent' | 'failed';
  error: string | null;
  duration: number | null;
  transcript: string | null;
  meta: Record<string, unknown>;
  media?: MediaRef | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
  seq: number;
  status: MessageStatus;
  clientMsgId: string | null;
  replyTo: string | null;
  error: string | null;
  content: MessagePart[];
  meta: Record<string, unknown>;
}

export interface MessagePage {
  messages: ChatMessage[];
  hasMore: boolean;
  nextSince?: number;
  lastEventSeq: number;
  lastMessageSeq: number;
  oldestSeq: number | null;
}

export interface MessageSearchHit {
  message: ChatMessage;
  snippet: string;
  matchedPartId: string | null;
}

export interface MessageContext {
  target: ChatMessage;
  messages: ChatMessage[];
  hasOlder: boolean;
  hasNewer: boolean;
}

export interface PersonaInfo {
  name: string;
  avatar: string;
  userAvatar: string;
  tagline: string;
}

export interface ConversationInfo {
  conversationId: string;
  persona: PersonaInfo;
  messageCount: number;
  lastSeq: number;
  lastEventSeq: number;
}

export interface StickerInfo {
  id: string;
  name: string;
  emotion: string;
  tags: string[];
  url: string;
  mediaId: string;
  description?: string | null;
  imageText?: string | null;
  userMeaning?: string | null;
  favorite?: boolean;
  assistantUseCount?: number;
  assistantLastUsedAt?: string | null;
  userUseCount?: number;
  analysisStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  userLastUsedAt?: string | null;
  animated?: boolean;
}

export interface LifeState {
  activity: string;
  kind: string;
  mood: string;
  startedAt: string;
  endsAt: string;
  recent: Array<{ activity: string; startedAt: string; endedAt: string }>;
}

export interface WorldPresence {
  city: { id: string; name: string; region?: string | null; country?: string | null } | null;
  location: { id: string; name: string; kind: string } | null;
  travel: {
    fromLocationId: string;
    fromName: string | null;
    toLocationId: string;
    toName: string | null;
    mode: string;
    expectedArriveAt: string;
  } | null;
  weather: {
    condition: WeatherCondition;
    temperatureC: number | null;
    feelsLikeC: number | null;
    observedAt: string;
    stale: boolean;
    provider: string;
  } | null;
  updatedAt: string;
}

export interface Moment {
  id: string;
  text: string;
  activity: string;
  image: { id: string; url: string; kind: 'pov' | 'selfie' | null } | null;
  location: { id: string | null; name: string | null; city: string | null } | null;
  weather: { condition: string; temperatureC: number | null } | null;
  liked: boolean;
  createdAt: string;
}

export interface BootstrapInfo {
  conversation: ConversationInfo;
  messages: { messages: ChatMessage[]; hasMore: boolean; lastEventSeq: number; lastMessageSeq: number; oldestSeq: number | null };
  stickers: StickerInfo[];
  life: LifeState;
  presence: WorldPresence;
}

export interface UploadInputFile {
  name: string;
  mime: string;
  bytes: Uint8Array;
  field: 'image' | 'file';
}

export interface LocalAdminRequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

export interface LocalCoreApi {
  bootstrap(): Promise<BootstrapInfo>;
  messages(options?: { limit?: number; before?: number; since?: number }): Promise<MessagePage>;
  messageSearch(query: string, options?: { limit?: number; cursor?: string | null }): Promise<{ hits: MessageSearchHit[]; nextCursor: string | null }>;
  messagesByDate(date: string, timeZone: string, limit?: number): Promise<{ date: string; timeZone: string; messages: ChatMessage[]; hasMore: boolean }>;
  messageContext(id: string, options?: { before?: number; after?: number }): Promise<MessageContext>;
  send(payload: { clientMsgId: string; content: unknown[]; directives?: Record<string, boolean>; replyTo?: string }): Promise<{ message: ChatMessage; duplicate: boolean; replyPending: boolean }>;
  withdraw(id: string): Promise<{ message: ChatMessage }>;
  retryBatch(id: string): Promise<{ batchId: string; revision: number; status: string }>;
  upload(files: UploadInputFile[], options?: { signal?: AbortSignal }): Promise<{ media: MediaRef[]; failed: Array<{ filename: string; error: string; code?: string }> }>;
  moments(limit?: number): Promise<{ moments: Moment[]; hasMore: boolean }>;
  likeMoment(id: string, liked: boolean): Promise<{ moment: Moment }>;
  stickerSearch(options?: { scope?: 'recent' | 'favorite' | 'all'; q?: string; limit?: number; cursor?: string | null }): Promise<{ stickers: StickerInfo[]; total: number; nextCursor: string | null }>;
  life(): Promise<LifeState>;
  presence(): Promise<WorldPresence>;
  capabilities(): Promise<{ capabilities: Record<string, { configured: boolean; ok: boolean; detail?: string }>; stickers: { available: number; total: number } }>;
  adminRequest<T = unknown>(path: string, options?: LocalAdminRequestOptions): Promise<T>;
  subscribe(listener: LocalEventListener): () => void;
}
