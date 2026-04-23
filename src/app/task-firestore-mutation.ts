import { deleteField, serverTimestamp } from '@angular/fire/firestore';
import { firestoreStatusFields, type TaskStatus } from '../models/task-status';
import { Task } from '../models/task';
import { normalizeTaskStatusFromDoc } from '../models/task-status';
import { timestampLikeToDate } from './task-schedule';
import { clampTaskPriority } from './task-priority';

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

export function mapFirestoreDocToTask(data: Record<string, unknown>): Task {
  const status = normalizeTaskStatusFromDoc(data);
  const label =
    typeof data['label'] === 'string' && data['label'].trim() !== '' ? data['label'] : '';
  const deadline = timestampLikeToDate(data['deadline']);
  const startAt = timestampLikeToDate(data['startAt']);
  const endAt = timestampLikeToDate(data['endAt']);
  const description = typeof data['description'] === 'string' ? data['description'] : '';
  const priority = clampTaskPriority(data['priority']);
  const rawAssignee = data['assignee'];
  const assignee =
    typeof rawAssignee === 'string' && rawAssignee.trim() !== ''
      ? rawAssignee.trim()
      : null;
  const rawLo = data['listOrderIndex'];
  const listOrderIndex =
    typeof rawLo === 'number' && !Number.isNaN(rawLo) ? rawLo : undefined;
  const rawKo = data['kanbanOrderIndex'];
  const kanbanOrderIndex =
    typeof rawKo === 'number' && !Number.isNaN(rawKo) ? rawKo : undefined;
  const rawKb = data['kanbanColumnId'];
  const kanbanColumnId =
    typeof rawKb === 'string' && rawKb.trim() !== '' ? rawKb.trim() : null;
  const rawParent = data['parentTaskId'];
  const parentTaskId =
    typeof rawParent === 'string' && rawParent.trim() !== '' ? rawParent.trim() : null;
  const createdAt = timestampLikeToDate(data['createdAt']);
  const updatedAt = timestampLikeToDate(data['updatedAt']);
  const completedAt = timestampLikeToDate(data['completedAt']);
  return {
      ...data,
      status,
      label,
      deadline,
      startAt,
      endAt,
      description,
      priority,
      assignee,
      listOrderIndex,
      kanbanOrderIndex,
      kanbanColumnId,
      parentTaskId,
      createdAt,
      updatedAt,
      completedAt,
    } as Task;
  }