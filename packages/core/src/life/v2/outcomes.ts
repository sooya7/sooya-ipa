import { hashText } from './theme.js';
import type { LifeActivityDefinition } from './types.js';
import type { LifeOutcome } from './types.js';

export function resolveOutcome(activity: LifeActivityDefinition, seed: number, occurredAt: string): LifeOutcome {
  const outcomes = activity.outcomes.length ? activity.outcomes : ['完成了这件事'];
  const index = hashText(`${activity.id}:${seed}:${occurredAt}`) % outcomes.length;
  const result = outcomes[index]!;
  const resultType: LifeOutcome['resultType'] = activity.kind === 'work' || activity.kind === 'study' ? 'neutral' : 'positive';
  const shareableBoost = activity.shareable ? 1 : 0;
  return {
    result,
    resultType,
    novelty: activity.shareable ? 0.35 + (hashText(`${activity.id}:${result}`) % 45) / 100 : 0.1,
    emotionalValue: activity.kind === 'social' || activity.kind === 'play' ? 0.7 : activity.shareable ? 0.4 : 0.12,
    relevanceToUser: 0.45 + (hashText(result) % 30) / 100,
    urgency: Math.min(0.6, 0.08 + shareableBoost * 0.2)
  };
}

export function threadProgressDelta(activity: LifeActivityDefinition, outcome: LifeOutcome): number {
  if (activity.threadCategory === '日常') return 0.06;
  return outcome.resultType === 'negative' ? 0.04 : 0.1;
}
