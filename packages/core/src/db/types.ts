export type Role = 'user' | 'assistant' | 'system';
export type MessageStatus = 'pending' | 'sending' | 'sent' | 'failed';
export type PartStatus = 'pending' | 'sent' | 'failed';
export type PartType = 'text' | 'sticker' | 'image' | 'audio' | 'file' | 'system';

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
  status: PartStatus;
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

export interface StreamEvent {
  id: string;
  seq: number;
  type: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

