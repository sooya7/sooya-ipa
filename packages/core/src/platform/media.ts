import type { BinaryData } from '../providers/types.js';

export type MediaKind = 'image' | 'audio' | 'sticker' | 'file';

export interface MediaRecord {
  id: string;
  kind: MediaKind;
  mime: string;
  bytes: number;
  name?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  metadata?: Record<string, unknown>;
}

export interface MediaSaveRequest {
  kind: MediaKind;
  data: BinaryData;
  mime?: string;
  name?: string;
  /** Spoken text for generated audio; persisted on the media row. */
  transcript?: string;
  metadata?: Record<string, unknown>;
}

export interface MediaPlatform {
  save(request: MediaSaveRequest): Promise<MediaRecord>;
  read(id: string): Promise<{ record: MediaRecord; data: Uint8Array } | null>;
  remove(id: string): Promise<boolean>;
  /** Removes a generated artifact completely: backing file AND catalog row.
   * Optional because plain platform stores only own the physical file;
   * remove() alone must keep gallery trash flows in control of rows. */
  destroy?(id: string): Promise<boolean>;
}

export type MediaAdapter = MediaPlatform;

