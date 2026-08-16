import type { LifeActivityDefinition, LifeOutcome, LifeThread } from './types.js';

export const DEFAULT_THREAD_DEFINITIONS = [
  { title: '日常生活', category: '日常', importance: 0.5 },
  { title: '关系与连接', category: '关系', importance: 0.6 },
  { title: '成长与学习', category: '成长', importance: 0.55 },
  { title: '事务推进', category: '事务', importance: 0.45 }
] as const;

export function pickDefaultThread(activity: LifeActivityDefinition, seed: number): { title: string; category: string; importance: number } {
  const matching = DEFAULT_THREAD_DEFINITIONS.filter((thread) => thread.category === activity.threadCategory);
  const pool = matching.length ? matching : DEFAULT_THREAD_DEFINITIONS;
  return pool[seed % pool.length]!;
}

export function advanceThread(
  thread: LifeThread,
  input: { activity: LifeActivityDefinition; outcome: LifeOutcome; now: string }
): LifeThread {
  const progress = clamp01(thread.progress + (input.outcome.resultType === 'negative' ? 0.03 : 0.09));
  const advanced = progress >= 1;
  return {
    ...thread,
    progress: advanced ? 0.05 : progress,
    heat: clamp01(thread.heat + (input.activity.shareable ? 0.08 : 0.03)),
    status: advanced ? 'resolved' : thread.status === 'resolved' ? 'open' : thread.status,
    nextActions: advanced
      ? [`回顾：${thread.title}`]
      : input.outcome.resultType === 'negative'
        ? [`再试一次：${input.activity.name}`]
        : [`继续：${input.activity.name}`]
  };
}

export function decayThread(thread: LifeThread, elapsedDays: number): LifeThread {
  const decay = Math.min(0.5, Math.max(0, elapsedDays) * 0.03);
  return { ...thread, heat: clamp01(thread.heat - decay), progress: clamp01(thread.progress - decay * 0.2) };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
