import { NotificationPolicy, notificationDedupeId } from './policy.js';
import type { LocalNotificationScheduler, NotificationDecision, NotificationEvent, NotificationPolicyState } from './types.js';

export interface NotificationPlannerOptions {
  scheduler: LocalNotificationScheduler;
  policy?: NotificationPolicy;
  now?: () => Date;
  recordDelivery?: (entry: { key: string; at: string }) => Promise<void>;
}

export class NotificationPlanner {
  private readonly now: () => Date;
  private readonly policy: NotificationPolicy;

  constructor(private readonly options: NotificationPlannerOptions) {
    this.now = options.now ?? (() => new Date());
    this.policy = options.policy ?? new NotificationPolicy();
  }

  async plan(event: NotificationEvent, state: NotificationPolicyState): Promise<{ decision: NotificationDecision; scheduled: boolean }> {
    const decision = this.policy.decide(event, { ...state, recent: state.recent.slice(0, 200) }, this.now());
    if (!decision.allow) return { decision, scheduled: false };
    await this.options.scheduler.schedule({
      id: notificationDedupeId(event),
      title: decision.title,
      body: decision.body,
      ...(decision.scheduleAt ? { scheduleAt: decision.scheduleAt } : {}),
      extra: { eventType: event.type, eventId: event.id, dedupeKey: decision.dedupeKey }
    });
    await this.options.recordDelivery?.({ key: decision.dedupeKey, at: this.now().toISOString() });
    return { decision, scheduled: true };
  }
}
