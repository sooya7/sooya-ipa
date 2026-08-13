import { Capacitor } from '@capacitor/core';

export interface LocalNotificationInput { id: number; title: string; body: string; scheduleAt?: Date; extra?: Record<string, unknown>; }
export interface NotificationBridge {
  checkPermissions(): Promise<unknown>;
  requestPermissions(): Promise<unknown>;
  schedule(options: { notifications: Array<Record<string, unknown>> }): Promise<unknown>;
  cancel(options: { notifications: Array<{ id: number }> }): Promise<unknown>;
  cancelAll(): Promise<unknown>;
  getPending(): Promise<unknown>;
  getDelivered(): Promise<unknown>;
  setBadge?(options: { count: number }): Promise<unknown>;
  addListener?(event: string, listener: (value: unknown) => void): Promise<{ remove: () => Promise<void> }>;
}

export interface PushBridge {
  checkPermissions(): Promise<unknown>;
  requestPermissions(): Promise<unknown>;
  register(): Promise<void>;
  addListener?(event: string, listener: (value: unknown) => void): Promise<{ remove: () => Promise<void> }>;
}

/** Explicit opt-in notification API. Bootstrap only probes capabilities. */
export class NativeNotifications {
  readonly local: NotificationBridge | null;
  readonly push: PushBridge | null;
  constructor(local?: NotificationBridge | null, push?: PushBridge | null) {
    const plugins = (Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins ?? {};
    this.local = local ?? (plugins.LocalNotifications as NotificationBridge | undefined) ?? null;
    this.push = push ?? (plugins.PushNotifications as PushBridge | undefined) ?? null;
  }
  async check(): Promise<{ local: unknown; push: unknown }> { return { local: await this.local?.checkPermissions(), push: await this.push?.checkPermissions() }; }
  async requestLocalPermission(): Promise<unknown> { if (!this.local) throw new Error('local notifications unavailable'); return await this.local.requestPermissions(); }
  async schedule(input: LocalNotificationInput): Promise<unknown> {
    if (!this.local) throw new Error('local notifications unavailable');
    return await this.local.schedule({ notifications: [{ id: input.id, title: input.title, body: input.body, ...(input.scheduleAt ? { schedule: { at: input.scheduleAt } } : {}), ...(input.extra ? { extra: input.extra } : {}) }] });
  }
  async cancel(id: number): Promise<unknown> { if (!this.local) throw new Error('local notifications unavailable'); return await this.local.cancel({ notifications: [{ id }] }); }
  async cancelAll(): Promise<unknown> { if (!this.local) throw new Error('local notifications unavailable'); return await this.local.cancelAll(); }
  async pending(): Promise<unknown> { if (!this.local) throw new Error('local notifications unavailable'); return await this.local.getPending(); }
  async delivered(): Promise<unknown> { if (!this.local) throw new Error('local notifications unavailable'); return await this.local.getDelivered(); }
  async setBadge(count: number): Promise<unknown> { if (!this.local?.setBadge) throw new Error('notification badges unavailable'); return await this.local.setBadge({ count: Math.max(0, Math.trunc(count)) }); }
  async registerPush(): Promise<void> { if (!this.push) throw new Error('push notifications unavailable'); await this.push.requestPermissions(); await this.push.register(); }
  async on(event: string, listener: (value: unknown) => void): Promise<() => Promise<void>> {
    const source = event.startsWith('push') ? this.push : this.local;
    if (!source?.addListener) throw new Error('notification listener unavailable');
    const handle = await source.addListener(event.replace(/^push\./u, ''), listener);
    return async () => { await handle.remove(); };
  }
}
