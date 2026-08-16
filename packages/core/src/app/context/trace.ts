import type { ContextBudgetDiagnostics, ContextBuildTrace, MemoryRecallTrace } from './types.js';

export function emptyMemoryTrace(): MemoryRecallTrace {
  return { queried: false, candidates: 0, accepted: 0, droppedDuplicate: 0, droppedBudget: 0 };
}

export function memoryTrace(input: {
  queried: boolean;
  candidates: number;
  accepted: number;
  droppedDuplicate: number;
  droppedBudget: number;
}): MemoryRecallTrace {
  return {
    queried: input.queried,
    candidates: Math.max(0, input.candidates),
    accepted: Math.max(0, input.accepted),
    droppedDuplicate: Math.max(0, input.droppedDuplicate),
    droppedBudget: Math.max(0, input.droppedBudget)
  };
}

export function buildTrace(input: {
  budget: ContextBudgetDiagnostics;
  memory: MemoryRecallTrace;
}): ContextBuildTrace {
  return { budget: input.budget, memory: input.memory };
}
