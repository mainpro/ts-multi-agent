import { MemoryEntry, MemoryLayer } from './types';

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'suspended' | 'waiting';

const EVICTABLE_STATUSES: TaskStatus[] = ['completed', 'failed'];

export function shouldEvictWorkingMemory(entry: MemoryEntry): boolean {
  if (entry.layer !== MemoryLayer.WORKING) return false;
  const status = entry.metadata?.taskStatus as TaskStatus | undefined;
  if (!status) return false;
  return EVICTABLE_STATUSES.includes(status);
}

export function evictCompletedWorkingMemory(entries: MemoryEntry[], completedTaskIds?: string[]): MemoryEntry[] {
  return entries.filter(entry => {
    if (entry.layer !== MemoryLayer.WORKING) return true;
    if (completedTaskIds && completedTaskIds.length > 0) {
      const taskId = entry.metadata?.taskId as string | undefined;
      if (taskId && completedTaskIds.includes(taskId)) return false;
    }
    return !shouldEvictWorkingMemory(entry);
  });
}
