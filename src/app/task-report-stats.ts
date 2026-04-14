import type { Task } from '../models/task';
import type { TaskStatus } from '../models/task-status';
import { taskDueEndAt } from './task-schedule';

const MS_DAY = 24 * 60 * 60 * 1000;

export function rollingSince(now: Date, days: number): Date {
  return new Date(now.getTime() - days * MS_DAY);
}

export function rollingUntil(now: Date, days: number): Date {
  return new Date(now.getTime() + days * MS_DAY);
}

export function countStatusBreakdown(tasks: Task[]): Record<TaskStatus, number> {
  const out: Record<TaskStatus, number> = {
    todo: 0,
    in_progress: 0,
    done: 0,
  };
  for (const t of tasks) {
    out[t.status]++;
  }
  return out;
}

/** 直近7日間に作成されたタスク（createdAt があるもののみカウント） */
export function countCreatedInLastDays(tasks: Task[], now: Date, days: number): number {
  const since = rollingSince(now, days);
  let n = 0;
  for (const t of tasks) {
    const c = t.createdAt;
    if (c && c >= since && c <= now) {
      n++;
    }
  }
  return n;
}

/** 直近7日間に完了したタスク */
export function countCompletedInLastDays(tasks: Task[], now: Date, days: number): number {
  const since = rollingSince(now, days);
  let n = 0;
  for (const t of tasks) {
    const x = t.completedAt;
    if (x && x >= since && x <= now) {
      n++;
    }
  }
  return n;
}

/**
 * 直近7日間に更新されたタスク（新規作成直後とみなす幅2秒は除外）
 */
export function countUpdatedInLastDays(tasks: Task[], now: Date, days: number): number {
  const since = rollingSince(now, days);
  let n = 0;
  for (const t of tasks) {
    const u = t.updatedAt;
    if (!u || u < since || u > now) {
      continue;
    }
    const c = t.createdAt;
    if (c && u.getTime() - c.getTime() <= 2000) {
      continue;
    }
    n++;
  }
  return n;
}

/** 未完了かつ期限が今から7日以内 */
export function countDueInNextDays(tasks: Task[], now: Date, days: number): number {
  const end = rollingUntil(now, days);
  let n = 0;
  for (const t of tasks) {
    if (t.status === 'done') {
      continue;
    }
    const due = taskDueEndAt(t);
    if (!due) {
      continue;
    }
    if (due.getTime() >= now.getTime() && due.getTime() <= end.getTime()) {
      n++;
    }
  }
  return n;
}

export function pieGradientFromBreakdown(
  breakdown: Record<TaskStatus, number>,
): string | null {
  const total = breakdown.todo + breakdown.in_progress + breakdown.done;
  if (total <= 0) {
    return null;
  }
  const cTodo = '#d1d1d1';
  const cProg = '#f5a37d';
  const cDone = '#a9ffad';
  let start = 0;
  const segs: string[] = [];
  const add = (count: number, color: string) => {
    if (count <= 0) {
      return;
    }
    const frac = count / total;
    const deg = frac * 360;
    const a = start;
    const b = start + deg;
    segs.push(`${color} ${a}deg ${b}deg`);
    start = b;
  };
  add(breakdown.todo, cTodo);
  add(breakdown.in_progress, cProg);
  add(breakdown.done, cDone);
  if (segs.length === 0) {
    return null;
  }
  return `conic-gradient(${segs.join(', ')})`;
}
