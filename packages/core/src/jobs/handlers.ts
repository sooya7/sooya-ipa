import type { DurableTask, DurableTaskHandler, DurableTaskType } from './local-task-scheduler.js';

export type TaskHandlerMap = Partial<Record<DurableTaskType, DurableTaskHandler>>;

export interface CoreTaskHandlerDeps {
  'life.catchup': DurableTaskHandler;
  'weather.refresh': DurableTaskHandler;
  'moment.compose': DurableTaskHandler;
  'moment.image': DurableTaskHandler;
  'sticker.analyze': DurableTaskHandler;
  'sticker.embed': DurableTaskHandler;
  'media.extract_text': DurableTaskHandler;
  'memory.commit': DurableTaskHandler;
  'memory.reembed': DurableTaskHandler;
  backup: DurableTaskHandler;
}

export function buildTaskHandlerMap(deps: CoreTaskHandlerDeps): TaskHandlerMap {
  return {
    'life.catchup': deps['life.catchup'],
    'weather.refresh': deps['weather.refresh'],
    'moment.compose': deps['moment.compose'],
    'moment.image': deps['moment.image'],
    'sticker.analyze': deps['sticker.analyze'],
    'sticker.embed': deps['sticker.embed'],
    'media.extract_text': deps['media.extract_text'],
    'memory.commit': deps['memory.commit'],
    'memory.reembed': deps['memory.reembed'],
    backup: deps.backup
  };
}

export function taskPayload(task: DurableTask): Record<string, unknown> {
  return task.payload ?? {};
}
