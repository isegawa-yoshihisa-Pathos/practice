export const TASK_PRIORITY_MIN = 1;
export const TASK_PRIORITY_MAX = 5;
export const DEFAULT_TASK_PRIORITY = 3;

export const TASK_PRIORITY_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 5, label: '5' },
  { value: 4, label: '4' },
  { value: 3, label: '3' },
  { value: 2, label: '2' },
  { value: 1, label: '1' },
];

export function clampTaskPriority(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (Number.isNaN(n)) {
    return DEFAULT_TASK_PRIORITY;
  }
  return Math.max(TASK_PRIORITY_MIN, Math.min(TASK_PRIORITY_MAX, n));
}

export function priorityShortLabel(p: number): string {
  const v = clampTaskPriority(p);
  return `${v}`;
}
