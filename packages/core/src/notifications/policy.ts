import { hashText } from '../life/v2/theme.js';
import type { NotificationDecision, NotificationEvent, NotificationPolicyState } from './types.js';

const PRIVATE_MARKERS = /\[\[(?:sticker|image|image-self|voice|voice-only|sticker-only)[^\]]*\]\]/gu;

export class NotificationPolicy {
  decide(event: NotificationEvent, state: NotificationPolicyState, now = event.at): NotificationDecision {
    const body = sanitizeBody(event.body, state.maxBodyLength);
    const dedupeKey = `${event.type}:${event.id}`;
    if (!body) return deny(event, 'empty_content', body, dedupeKey);
    if (!state.permission.supported) return deny(event, 'not_supported', body, dedupeKey);
    if (!state.permission.enabled || !state.permission.granted) return deny(event, 'denied', body, dedupeKey);
    if (state.foregroundSuppression && event.appActive) return deny(event, 'foreground', body, dedupeKey);
    if (state.quietHours && insideQuietHours(now, state.quietHours)) return deny(event, 'quiet_hours', body, dedupeKey);
    const today = now.toISOString().slice(0, 10);
    if (state.recent.some((entry) => entry.key === dedupeKey)) return deny(event, 'duplicate', body, dedupeKey);
    const deliveredToday = state.recent.filter((entry) => entry.at.slice(0, 10) === today).length;
    if (deliveredToday >= state.dailyCap) return deny(event, 'daily_cap', body, dedupeKey);
    return {
      allow: true,
      reason: 'ok',
      title: sanitizeTitle(event.title, 60),
      body,
      dedupeKey,
      ...(event.extra?.delayMs ? { scheduleAt: new Date(now.getTime() + Number(event.extra.delayMs)) } : {})
    };
  }
}

export function sanitizeBody(value: string, maxLength: number): string {
  return value
    .replace(PRIVATE_MARKERS, '')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxLength);
}

export function sanitizeTitle(value: string | undefined, maxLength: number): string {
  return sanitizeBody(value ?? 'SOOYA', maxLength) || 'SOOYA';
}

function deny(event: NotificationEvent, reason: NotificationDecision['reason'], body: string, dedupeKey: string): NotificationDecision {
  return { allow: false, reason, title: sanitizeTitle(event.title, 60), body, dedupeKey };
}

function insideQuietHours(at: Date, quietHours: NotificationPolicyState['quietHours'] & {}): boolean {
  if (!quietHours) return false;
  let hour: number;
  try {
    hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: quietHours.timeZone, hour: 'numeric', hour12: false }).format(at));
  } catch {
    hour = at.getHours();
  }
  const from = quietHours.fromHour;
  const to = quietHours.toHour;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

export function notificationDedupeId(event: NotificationEvent): number {
  const hash = hashText(`${event.type}:${event.id}`) % 1_000_000;
  return 700_000 + hash;
}
