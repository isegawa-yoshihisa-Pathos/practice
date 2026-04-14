import { deleteField, serverTimestamp } from '@angular/fire/firestore';
import { firestoreStatusFields, type TaskStatus } from '../models/task-status';

/** 進捗変更時に `updatedAt` / `completedAt` を同期する */
export function taskStatusTransitionPatch(
  next: TaskStatus,
  prev: TaskStatus,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    ...firestoreStatusFields(next),
    updatedAt: serverTimestamp(),
  };
  if (next === 'done' && prev !== 'done') {
    patch['completedAt'] = serverTimestamp();
  } else if (next !== 'done') {
    patch['completedAt'] = deleteField();
  }
  return patch;
}
