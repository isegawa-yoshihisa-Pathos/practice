import { Task } from '../models/task';
import { Timestamp } from '@angular/fire/firestore';

export type TaskScheduleMode = 'deadline' | 'window' | 'none';

/** Firestore / フォームから Date へ */
export function timestampLikeToDate(raw: unknown): Date | null {
  if (raw == null) {
    return null;
  }
  if (raw instanceof Timestamp) {
    return raw.toDate();
  }
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : raw;
  }
  if (typeof raw === 'number' || typeof raw === 'string') {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function parseTs(raw: unknown): Date | null {
  return timestampLikeToDate(raw);
}

/** 生の日時からモード判定（読み込み直後用） */
export function taskScheduleModeFromFields(
  deadline: Date | null | undefined,
  startAt: Date | null | undefined,
  endAt: Date | null | undefined,
): TaskScheduleMode {
  return taskScheduleMode({
    title: '',
    label: '',
    status: 'todo',
    priority: 3,
    deadline: deadline ?? null,
    startAt: startAt ?? null,
    endAt: endAt ?? null,
  } as Task);
}

/** Firestore / 画面から Task を組み立てたあとに呼ぶ想定 */
export function taskScheduleMode(task: Task): TaskScheduleMode {
  const dl = task.deadline ? parseTs(task.deadline) : null;
  const s = task.startAt ? parseTs(task.startAt) : null;
  const e = task.endAt ? parseTs(task.endAt) : null;
  if (s && e) {
    return 'window';
  }
  if (dl) {
    return 'deadline';
  }
  return 'none';
}

/** 期限切れ判定の基準時刻（締切日時 または 開始日時） */
export function overdueThresholdAt(task: Task): Date | null {
  const m = taskScheduleMode(task);
  if (m === 'deadline' && task.deadline) {
    return parseTs(task.deadline);
  }
  if (m === 'window' && task.startAt) {
    return parseTs(task.startAt);
  }
  return null;
}

export function isTaskOverdue(task: Task, now: Date = new Date()): boolean {
  if (task.status === 'done') {
    return false;
  }
  const t = overdueThresholdAt(task);
  if (!t) {
    return false;
  }
  return t.getTime() < now.getTime();
}

/** 締切または予定終了（期限の集計用）。どちらも無ければ null */
export function taskDueEndAt(task: Task): Date | null {
  const m = taskScheduleMode(task);
  if (m === 'deadline' && task.deadline) {
    return timestampLikeToDate(task.deadline);
  }
  if (m === 'window' && task.endAt) {
    return timestampLikeToDate(task.endAt);
  }
  return null;
}

/** フィルタ・期日ソート用：日単位の代表日（ローカル日の開始） */
export function filterAnchorDayStart(task: Task): Date | null {
  const m = taskScheduleMode(task);
  const d =
    m === 'deadline' && task.deadline
      ? parseTs(task.deadline)
      : m === 'window' && task.startAt
        ? parseTs(task.startAt)
        : null;
  if (!d) {
    return null;
  }
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** 並び替え「締切日時」キー用のミリ秒（なしは null） */
export function effectiveScheduleTimestamp(task: Task): number | null {
  const t = overdueThresholdAt(task);
  return t ? t.getTime() : null;
}

/** カレンダー月/週グリッド：その日のセルに載せるか（窓は期間中の各日に表示） */
export function taskTouchesCalendarDay(task: Task, day: Date): boolean {
  const sod = startOfLocalDay(day).getTime();
  const eod = sod + 86400000 - 1;
  const m = taskScheduleMode(task);
  if (m === 'deadline' && task.deadline) {
    const t = parseTs(task.deadline)!.getTime();
    return t >= sod && t <= eod;
  }
  if (m === 'window' && task.startAt && task.endAt) {
    const ts = parseTs(task.startAt)!.getTime();
    const te = parseTs(task.endAt)!.getTime();
    return !(te < sod || ts > eod);
  }
  return false;
}

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/** `<input type="datetime-local">` 用（ローカル） */
export function toDatetimeLocalString(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) {
    return '';
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromDatetimeLocalString(s: string): Date | null {
  const t = s?.trim();
  if (!t) {
    return null;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 締切日時・開始のデフォルト（現在のローカル日時、1分単位） */
export function defaultScheduleDatetimeLocalNow(): string {
  return toDatetimeLocalString(new Date());
}

/** 終了のデフォルト（現在から1時間後） */
export function defaultScheduleDatetimeLocalOneHourLater(): string {
  const d = new Date();
  d.setHours(d.getHours() + 1);
  return toDatetimeLocalString(d);
}
