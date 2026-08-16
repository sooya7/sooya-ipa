export type NotificationEvent =
  | {
      type: 'reply.completed';
      id: string;
      at: Date;
      appActive: boolean;
      title?: string;
      body: string;
      extra?: Record<string, unknown>;
    }
  | {
      type: 'important_moment';
      id: string;
      at: Date;
      appActive: boolean;
      title?: string;
      body: string;
      extra?: Record<string, unknown>;
    };

export interface NotificationPermissionState {
  supported: boolean;
  enabled: boolean;
  granted: boolean;
}

export interface NotificationQuietHours {
  fromHour: number;
  toHour: number;
  timeZone: string;
}

export interface NotificationPolicyState {
  permission: NotificationPermissionState;
  foregroundSuppression: boolean;
  quietHours: NotificationQuietHours | null;
  dailyCap: number;
  recent: Array<{ key: string; at: string }>;
  maxBodyLength: number;
}

export interface NotificationDecision {
  allow: boolean;
  reason: 'ok' | 'denied' | 'not_supported' | 'foreground' | 'quiet_hours' | 'daily_cap' | 'duplicate' | 'empty_content';
  title: string;
  body: string;
  dedupeKey: string;
  scheduleAt?: Date;
}

export interface LocalNotificationScheduler {
  schedule(input: { id: number; title: string; body: string; scheduleAt?: Date; extra?: Record<string, unknown> }): Promise<unknown>;
  cancel(id: number): Promise<unknown>;
  cancelAll(): Promise<unknown>;
}
