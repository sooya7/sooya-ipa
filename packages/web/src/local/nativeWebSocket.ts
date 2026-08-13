import { Capacitor } from '@capacitor/core';

export interface NativeWebSocketEvent { id: string; text?: string; dataBase64?: string; reason?: string; message?: string; protocol?: string; }
interface WebSocketPlugin { call<T>(method: string, options: Record<string, unknown>): Promise<T>; addListener?: (event: string, listener: (event: NativeWebSocketEvent) => void) => Promise<{ remove: () => Promise<void> }>; }

/** Native WebSocket transport; JSON-RPC/protocol handling stays in TS. */
export class NativeWebSocketTransport {
  private readonly plugin: WebSocketPlugin | null;
  constructor(plugin?: WebSocketPlugin | null) {
    this.plugin = plugin ?? ((Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins?.SOOYAWebSocket as WebSocketPlugin | undefined) ?? null;
  }
  async connect(id: string, url: string, options: { secretRef?: string; secretHeader?: string; secretPrefix?: string } = {}): Promise<void> { await this.require().call('connect', { id, url, ...options }); }
  async send(id: string, payload: string | Uint8Array): Promise<void> {
    const bytes = payload instanceof Uint8Array ? payload : new TextEncoder().encode(payload);
    if (typeof payload === 'string') await this.require().call('send', { id, text: payload });
    else await this.require().call('send', { id, dataBase64: toBase64(bytes) });
  }
  async close(id: string): Promise<void> { await this.require().call('close', { id }); }
  async abort(id: string): Promise<void> { await this.require().call('abort', { id }); }
  async on(event: 'open' | 'message' | 'error' | 'close', listener: (value: NativeWebSocketEvent) => void): Promise<() => Promise<void>> {
    const handle = await this.require().addListener?.(event, listener);
    return async () => { await handle?.remove(); };
  }
  private require(): WebSocketPlugin { if (!this.plugin) throw new Error('native websocket bridge is unavailable'); return this.plugin; }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
