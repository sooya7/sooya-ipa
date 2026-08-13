import type { BinaryData } from '../providers/types.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';

export interface HttpRequest {
  url: string;
  method?: HttpMethod;
  headers?: Readonly<Record<string, string>>;
  body?: string | BinaryData;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface HttpResponseHead {
  status: number;
  headers: Readonly<Record<string, string>>;
}

export interface HttpPlatform {
  request(request: HttpRequest): Promise<HttpResponse>;
  stream(request: HttpRequest, onChunk: (chunk: Uint8Array) => void): Promise<HttpResponseHead>;
}

export type HttpAdapter = HttpPlatform;
