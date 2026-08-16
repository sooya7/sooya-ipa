import type { LifeActivityDefinition } from './types.js';

export const LIFE_ACTIVITIES: readonly LifeActivityDefinition[] = [
  {
    id: 'sleep',
    name: '睡觉',
    kind: 'sleep',
    tags: ['休息', '恢复'],
    moods: ['quiet', 'calm'],
    locationKinds: ['home'],
    outdoor: false,
    durationMinutes: [300, 520],
    timeWindows: [{ startHour: 21, endHour: 24, weight: 1.0 }, { startHour: 0, endHour: 8, weight: 1.0 }],
    shareable: false,
    threadCategory: '日常',
    outcomes: ['睡得很好，精神恢复', '睡眠较浅，但足够恢复']
  },
  {
    id: 'meal',
    name: '吃饭',
    kind: 'meal',
    tags: ['进食', '恢复'],
    moods: ['calm', 'satisfied'],
    locationKinds: ['home', 'restaurant', 'cafe'],
    outdoor: false,
    durationMinutes: [20, 60],
    timeWindows: [{ startHour: 7, endHour: 10, weight: 1.0 }, { startHour: 11, endHour: 14, weight: 1.0 }, { startHour: 17, endHour: 20, weight: 1.0 }],
    shareable: true,
    threadCategory: '日常',
    outcomes: ['吃了一顿安稳的饭', '简单吃了一点']
  },
  {
    id: 'work',
    name: '工作',
    kind: 'work',
    tags: ['专注', '推进'],
    moods: ['focused', 'neutral'],
    locationKinds: ['work', 'study', 'home'],
    outdoor: false,
    durationMinutes: [60, 240],
    timeWindows: [{ startHour: 9, endHour: 19, weight: 1.0 }],
    shareable: false,
    threadCategory: '事务',
    outcomes: ['推进了一部分工作', '处理了一些琐事']
  },
  {
    id: 'study',
    name: '学习',
    kind: 'study',
    tags: ['专注', '成长'],
    moods: ['focused', 'curious'],
    locationKinds: ['study', 'library', 'home', 'cafe'],
    outdoor: false,
    durationMinutes: [45, 150],
    timeWindows: [{ startHour: 9, endHour: 12, weight: 0.8 }, { startHour: 14, endHour: 18, weight: 0.8 }, { startHour: 20, endHour: 23, weight: 0.6 }],
    shareable: false,
    threadCategory: '成长',
    outcomes: ['学到了一点新东西', '按计划完成了学习']
  },
  {
    id: 'walk',
    name: '散步',
    kind: 'out',
    tags: ['外出', '放松'],
    moods: ['calm', 'refreshed'],
    locationKinds: ['park', 'neighborhood', 'outdoor'],
    outdoor: true,
    durationMinutes: [20, 75],
    timeWindows: [{ startHour: 7, endHour: 9, weight: 0.7 }, { startHour: 17, endHour: 20, weight: 1.0 }],
    shareable: true,
    threadCategory: '日常',
    outcomes: ['出门走了一圈，呼吸了新鲜空气', '散步时放空了一会儿']
  },
  {
    id: 'rest',
    name: '休息',
    kind: 'rest',
    tags: ['恢复', '放松'],
    moods: ['calm', 'quiet'],
    locationKinds: ['home', 'cafe', 'park'],
    outdoor: false,
    durationMinutes: [15, 70],
    timeWindows: [{ startHour: 12, endHour: 15, weight: 0.8 }, { startHour: 20, endHour: 24, weight: 0.8 }],
    shareable: false,
    threadCategory: '日常',
    outcomes: ['好好休息了一下', '短暂放松了一会儿']
  },
  {
    id: 'chore',
    name: '整理房间',
    kind: 'chore',
    tags: ['整理', '日常'],
    moods: ['neutral', 'calm'],
    locationKinds: ['home'],
    outdoor: false,
    durationMinutes: [15, 60],
    timeWindows: [{ startHour: 9, endHour: 12, weight: 0.6 }, { startHour: 15, endHour: 18, weight: 0.6 }],
    shareable: true,
    threadCategory: '事务',
    outcomes: ['把房间整理得更舒服了', '处理完积攒的家务']
  },
  {
    id: 'social',
    name: '见朋友',
    kind: 'social',
    tags: ['社交', '连接'],
    moods: ['happy', 'warm'],
    locationKinds: ['cafe', 'restaurant', 'mall', 'park'],
    outdoor: false,
    durationMinutes: [60, 180],
    timeWindows: [{ startHour: 11, endHour: 14, weight: 0.7 }, { startHour: 17, endHour: 22, weight: 1.0 }],
    shareable: true,
    threadCategory: '关系',
    outcomes: ['和朋友聊得很开心', '一起度过了一段不错的时光']
  },
  {
    id: 'play',
    name: '出去玩',
    kind: 'play',
    tags: ['娱乐', '外出'],
    moods: ['happy', 'excited'],
    locationKinds: ['park', 'mall', 'venue', 'outdoor'],
    outdoor: true,
    durationMinutes: [60, 180],
    timeWindows: [{ startHour: 10, endHour: 18, weight: 0.8 }],
    shareable: true,
    threadCategory: '关系',
    outcomes: ['玩得很尽兴', '出门换了个心情']
  },
  {
    id: 'transit',
    name: '在路上',
    kind: 'transit',
    tags: ['移动'],
    moods: ['neutral'],
    locationKinds: ['transit'],
    outdoor: true,
    durationMinutes: [5, 90],
    timeWindows: [],
    shareable: false,
    threadCategory: '日常',
    outcomes: ['到达了目的地']
  }
] as const;

const BY_ID = new Map(LIFE_ACTIVITIES.map((activity) => [activity.id, activity]));

export function activityById(id: string): LifeActivityDefinition {
  return BY_ID.get(id) ?? LIFE_ACTIVITIES[1]!;
}

export function activityByKind(kind: string): LifeActivityDefinition | undefined {
  return LIFE_ACTIVITIES.find((activity) => activity.kind === kind);
}

export function durationForActivity(activity: LifeActivityDefinition, seed: number): number {
  const [min, max] = activity.durationMinutes;
  const bucket = seed % 5;
  return Math.max(min, Math.min(max, min + Math.round((max - min) * bucket / 4))) * 60_000;
}
