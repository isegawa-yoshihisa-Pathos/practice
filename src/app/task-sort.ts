import { Task } from '../models/task';
import { TASK_COLOR_CHART } from './task-colors';
import { clampTaskPriority } from './task-priority';

export type TaskSortField = 'color' | 'deadline' | 'priority';

function colorSortIndex(hex: string | undefined): number {
  const c = hex?.trim() ?? '';
  const idx = (TASK_COLOR_CHART as readonly string[]).indexOf(c);
  return idx >= 0 ? idx : TASK_COLOR_CHART.length;
}

function compareColor(a: Task, b: Task, ascending: boolean): number {
  const ia = colorSortIndex(a.label);
  const ib = colorSortIndex(b.label);
  let cmp = ia - ib;
  if (cmp === 0 && a.label !== b.label) {
    cmp = (a.label ?? '').localeCompare(b.label ?? '');
  }
  return ascending ? cmp : -cmp;
}

/** 期日なしは常に末尾（昇順・降順どちらも） */
function compareDeadline(a: Task, b: Task, ascending: boolean): number {
  const ta = a.deadline?.getTime();
  const tb = b.deadline?.getTime();
  const aNull = ta === undefined || Number.isNaN(ta as number);
  const bNull = tb === undefined || Number.isNaN(tb as number);
  if (aNull && bNull) {
    return 0;
  }
  if (aNull) {
    return 1;
  }
  if (bNull) {
    return -1;
  }
  const cmp = (ta as number) - (tb as number);
  return ascending ? cmp : -cmp;
}

function comparePriority(a: Task, b: Task, ascending: boolean): number {
  const pa = clampTaskPriority(a.priority);
  const pb = clampTaskPriority(b.priority);
  const cmp = pa - pb;
  return ascending ? cmp : -cmp;
}

function compareField(a: Task, b: Task, field: TaskSortField, ascending: boolean): number {
  switch (field) {
    case 'color':
      return compareColor(a, b, ascending);
    case 'deadline':
      return compareDeadline(a, b, ascending);
    case 'priority':
      return comparePriority(a, b, ascending);
    default:
      return 0;
  }
}

/** 先頭から順に比較。同じキーは1回だけ使う。 */
export function sortTasks(
  tasks: Task[],
  keys: TaskSortField[],
  ascending: boolean,
): Task[] {
  const seen = new Set<TaskSortField>();
  const uniqueKeys: TaskSortField[] = [];
  for (const k of keys) {
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    uniqueKeys.push(k);
  }
  if (uniqueKeys.length === 0) {
    return tasks;
  }
  return [...tasks].sort((a, b) => {
    for (const field of uniqueKeys) {
      const c = compareField(a, b, field, ascending);
      if (c !== 0) {
        return c;
      }
    }
    return 0;
  });
}
