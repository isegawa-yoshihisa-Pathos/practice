import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { Task } from '../../models/task';
import { TaskScope, taskDetailScopeParam } from '../task-scope';
import { clampTaskPriority } from '../task-priority';
import { saveTaskShellScrollPosition } from '../task-shell-scroll';
import { taskScheduleMode, timestampLikeToDate } from '../task-schedule';

/** 月表示：同一日付に並べるタスクの最大数 */
export const CALENDAR_MONTH_MAX_PER_DAY = 5;
/** 週表示：同一日付に並べるタスクの最大数 */
export const CALENDAR_WEEK_MAX_PER_DAY = 30;
/** 一日表示：表示するタスクの最大数（タイムライン外のオーバーフロー表示用） */
export const CALENDAR_DAY_MAX = 80;

/** 一日タイムライン：1時間あたりの高さ（px） */
export const CALENDAR_DAY_TIMELINE_SLOT_PX = 44;
/** 一日タイムライン：表示する時間帯（0〜23） */
export const CALENDAR_DAY_TIMELINE_START_HOUR = 0;
export const CALENDAR_DAY_TIMELINE_END_HOUR = 24;

/** 一日の「締切」枠：締切日時の早い順 */
export interface DayDeadlineEntry {
  task: Task;
  at: Date;
  timeLabel: string;
}

export interface DayTimelineBlock {
  task: Task;
  topPx: number;
  heightPx: number;
  rangeLabel: string;
  /** 重なりグループ内の列（0 ＝ 最左・開始が最も早い列） */
  laneIndex: number;
  /** 同じ重なりグループ内の列数 */
  laneCount: number;
}

/** カレンダー粒度（TaskList の `calendarGranularity` と共有） */
export type TaskCalendarGranularity = 'month' | 'week' | 'day';

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function compareTasksInCell(a: Task, b: Task): number {
  const pa = clampTaskPriority(a.priority);
  const pb = clampTaskPriority(b.priority);
  if (pb !== pa) {
    return pb - pa;
  }
  return (a.title ?? '').localeCompare(b.title ?? '');
}

/** ローカル日の [sod, 翌0時) にクリップした区間。交差しなければ null */
function clipIntervalToCalendarDay(day: Date, start: Date, end: Date): { start: Date; end: Date } | null {
  const sod = startOfDay(day);
  const dayEndMs = sod.getTime() + 86400000;
  const sMs = Math.max(start.getTime(), sod.getTime());
  const eMs = Math.min(end.getTime(), dayEndMs);
  if (eMs <= sMs) {
    return null;
  }
  return { start: new Date(sMs), end: new Date(eMs) };
}

function formatHm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 分単位の区間 [s,e) が交差するか（端の接続は重ならない） */
function intervalsOverlapMinutes(s1: number, e1: number, s2: number, e2: number): boolean {
  return s1 < e2 && s2 < e1;
}

interface DayTimelineRaw {
  task: Task;
  visStart: number;
  visEnd: number;
  topPx: number;
  heightPx: number;
  rangeLabel: string;
}

function unionFindOverlapGroups(n: number, shouldUnion: (i: number, j: number) => boolean): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    if (parent[x] !== x) {
      parent[x] = find(parent[x]);
    }
    return parent[x];
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[rb] = ra;
    }
  }
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (shouldUnion(i, j)) {
        union(i, j);
      }
    }
  }
  const map = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = map.get(r);
    if (arr) {
      arr.push(i);
    } else {
      map.set(r, [i]);
    }
  }
  return [...map.values()];
}

/**
 * 重なり連結成分の中で列を割り当てる。
 * 開始が早い順に左（列番号 0,1,…）。同時刻は終了が早い順、それでも同じならタスクの比較。
 */
function assignLanesInOverlapGroup(
  raw: DayTimelineRaw[],
  indices: number[],
): Map<number, { laneIndex: number; laneCount: number }> {
  const sortedIdx = [...indices].sort((ia, ib) => {
    const a = raw[ia];
    const b = raw[ib];
    if (a.visStart !== b.visStart) {
      return a.visStart - b.visStart;
    }
    if (a.visEnd !== b.visEnd) {
      return a.visEnd - b.visEnd;
    }
    return compareTasksInCell(a.task, b.task);
  });
  const columns: { start: number; end: number }[][] = [];
  const out = new Map<number, { laneIndex: number; laneCount: number }>();
  for (const idx of sortedIdx) {
    const b = raw[idx];
    let lane = 0;
    for (;;) {
      if (!columns[lane]) {
        columns[lane] = [];
      }
      const hasOv = columns[lane].some((iv) =>
        intervalsOverlapMinutes(b.visStart, b.visEnd, iv.start, iv.end),
      );
      if (!hasOv) {
        columns[lane].push({ start: b.visStart, end: b.visEnd });
        out.set(idx, { laneIndex: lane, laneCount: 0 });
        break;
      }
      lane++;
    }
  }
  const laneCount = columns.length;
  for (const idx of indices) {
    const entry = out.get(idx);
    if (entry) {
      entry.laneCount = laneCount;
    }
  }
  return out;
}

/** 月グリッド用：含まれる月の viewMonth の週（日曜始まり）×7日 */
function buildMonthWeeks(viewMonth: Date): Date[][] {
  const y = viewMonth.getFullYear();
  const m = viewMonth.getMonth();
  const first = new Date(y, m, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  const weeks: Date[][] = [];
  const cur = new Date(start);
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) {
      row.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
    weeks.push(row);
  }
  return weeks;
}

function startOfWeekSunday(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() - x.getDay());
  return x;
}

@Component({
  selector: 'app-task-calendar',
  standalone: true,
  imports: [CommonModule, MatButtonModule],
  templateUrl: './task-calendar.html',
  styleUrl: './task-calendar.css',
})
export class TaskCalendar {
  private readonly router = inject(Router);

  @Input({ required: true }) tasks: Task[] = [];
  @Input({ required: true }) taskScope!: TaskScope;
  @Input() granularity: TaskCalendarGranularity = 'month';

  /** 親（TaskList）と同期するナビ基準日 */
  private _viewDate = new Date();

  @Input()
  set viewDate(v: Date) {
    const next = v != null ? new Date(v.getTime()) : new Date();
    if (Number.isNaN(next.getTime())) {
      return;
    }
    if (this._viewDate.getTime() === next.getTime()) {
      return;
    }
    this._viewDate = next;
  }

  get viewDate(): Date {
    return this._viewDate;
  }

  /** ツールバー等で日付が変わったとき（親が URL などと同期する） */
  @Output() viewDateChange = new EventEmitter<Date>();

  /** 月グリッドの日付をクリックしたとき（親は日表示へ切り替え） */
  @Output() pickCalendarDay = new EventEmitter<Date>();

  /** チップ／ブロック上の右クリック（親がコンテキストメニューを開く） */
  @Output() taskContextMenu = new EventEmitter<{
    clientX: number;
    clientY: number;
    task: Task;
  }>();

  readonly maxMonth = CALENDAR_MONTH_MAX_PER_DAY;
  readonly maxWeek = CALENDAR_WEEK_MAX_PER_DAY;
  readonly maxDay = CALENDAR_DAY_MAX;

  readonly dayTimelineSlotPx = CALENDAR_DAY_TIMELINE_SLOT_PX;
  readonly dayTimelineStartHour = CALENDAR_DAY_TIMELINE_START_HOUR;
  readonly dayTimelineEndHour = CALENDAR_DAY_TIMELINE_END_HOUR;

  /** 一日タイムライン左側の時間ラベル用（例: 0〜23） */
  get dayTimelineHourLabels(): number[] {
    const out: number[] = [];
    for (let h = this.dayTimelineStartHour; h < this.dayTimelineEndHour; h++) {
      out.push(h);
    }
    return out;
  }

  /** スクロール領域内タイムグリッドの高さ（px） */
  get dayTimelineGridHeightPx(): number {
    return (this.dayTimelineEndHour - this.dayTimelineStartHour) * this.dayTimelineSlotPx;
  }

  readonly weekdayLabels = ['日', '月', '火', '水', '木', '金', '土'];

  openTask(task: Task): void {
    const id = task.id;
    if (!id) {
      return;
    }
    const scope = taskDetailScopeParam(this.taskScope);
    saveTaskShellScrollPosition();
    void this.router.navigate(['/task', scope, id], {
      queryParams: {
        from: 'calendar',
        cal: this.granularity,
      },
    });
  }

  goToday(): void {
    this.emitViewDate(new Date());
  }

  goPrevMonth(): void {
    const x = new Date(this._viewDate);
    x.setDate(1);
    x.setMonth(x.getMonth() - 1);
    this.emitViewDate(x);
  }

  goNextMonth(): void {
    const x = new Date(this._viewDate);
    x.setDate(1);
    x.setMonth(x.getMonth() + 1);
    this.emitViewDate(x);
  }

  goPrevWeek(): void {
    const x = new Date(this._viewDate);
    x.setDate(x.getDate() - 7);
    this.emitViewDate(x);
  }

  goNextWeek(): void {
    const x = new Date(this._viewDate);
    x.setDate(x.getDate() + 7);
    this.emitViewDate(x);
  }

  goPrevDay(): void {
    const x = new Date(this._viewDate);
    x.setDate(x.getDate() - 1);
    this.emitViewDate(x);
  }

  goNextDay(): void {
    const x = new Date(this._viewDate);
    x.setDate(x.getDate() + 1);
    this.emitViewDate(x);
  }

  /** 月表示：日付セルをクリック → その日の日表示へ（親が粒度を切り替え） */
  pickMonthDay(date: Date): void {
    const d = startOfDay(new Date(date));
    this._viewDate = d;
    this.pickCalendarDay.emit(new Date(d.getTime()));
  }

  /** 月セル：キーボード・スクリーンリーダー用 */
  monthDayOpenAriaLabel(d: Date): string {
    return `${d.getMonth() + 1}月${d.getDate()}日の一日表示を開く`;
  }

  private emitViewDate(next: Date): void {
    this._viewDate = new Date(next.getTime());
    this.viewDateChange.emit(new Date(this._viewDate.getTime()));
  }

  get monthTitle(): string {
    const y = this.viewDate.getFullYear();
    const m = this.viewDate.getMonth() + 1;
    return `${y}年 ${m}月`;
  }

  get weekTitleRange(): string {
    const start = startOfWeekSunday(this.viewDate);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    const y1 = start.getFullYear();
    const m1 = start.getMonth() + 1;
    const d1 = start.getDate();
    const m2 = end.getMonth() + 1;
    const d2 = end.getDate();
    if (y1 === end.getFullYear()) {
      return `${y1}年 ${m1}/${d1} – ${m2}/${d2}`;
    }
    return `${y1}年 ${m1}/${d1} – ${end.getFullYear()}年 ${m2}/${d2}`;
  }

  get dayTitle(): string {
    const d = this.viewDate;
    return `${d.getFullYear()}年 ${d.getMonth() + 1}月 ${d.getDate()}日（${this.weekdayLabels[d.getDay()]}）`;
  }

  /** 一日表示：その日のタスク（優先度→タイトル、件数上限あり） */
  get dayTasks(): { items: Task[]; overflow: number } {
    const sorted = this.viewDayTasksSorted();
    const cap = this.maxDay;
    const items = sorted.slice(0, cap);
    const overflow = Math.max(0, sorted.length - cap);
    return { items, overflow };
  }

  /**
   * 一日の締切タスク（タイムライン上ではなく上枠に表示）。締切日時の早い順。
   */
  get dayDeadlines(): DayDeadlineEntry[] {
    const sorted = this.viewDayTasksSorted();
    const out: DayDeadlineEntry[] = [];
    for (const task of sorted) {
      if (taskScheduleMode(task) !== 'deadline') {
        continue;
      }
      const dl = timestampLikeToDate(task.deadline);
      if (!dl || !sameCalendarDay(dl, this.viewDate)) {
        continue;
      }
      out.push({
        task,
        at: dl,
        timeLabel: formatHm(dl),
      });
    }
    out.sort((a, b) => a.at.getTime() - b.at.getTime());
    return out;
  }

  /**
   * 一日タイムライン：予定（開始〜終了）のみ帯で表示。
   * 日をまたぐ予定はその日の 0:00〜翌0:00 にクリップ。
   * 時間が重なる予定は列に分割し、開始が早いほど左列。
   */
  get dayTimeline(): { blocks: DayTimelineBlock[] } {
    const sorted = this.viewDayTasksSorted();

    const rangeMin = (this.dayTimelineEndHour - this.dayTimelineStartHour) * 60;
    const totalPx = this.dayTimelineGridHeightPx;
    const sod = startOfDay(new Date(this.viewDate));

    const raw: DayTimelineRaw[] = [];

    for (const task of sorted) {
      if (taskScheduleMode(task) !== 'window') {
        continue;
      }
      const s = timestampLikeToDate(task.startAt);
      const e = timestampLikeToDate(task.endAt);
      if (!s || !e) {
        continue;
      }
      const clipped = clipIntervalToCalendarDay(this.viewDate, s, e);
      if (!clipped) {
        continue;
      }
      const startMin =
        (clipped.start.getTime() - sod.getTime()) / 60000 - this.dayTimelineStartHour * 60;
      const endMin =
        (clipped.end.getTime() - sod.getTime()) / 60000 - this.dayTimelineStartHour * 60;
      if (endMin <= 0 || startMin >= rangeMin) {
        continue;
      }
      const visStart = Math.max(0, startMin);
      const visEnd = Math.min(rangeMin, endMin);
      const topPx = (visStart / rangeMin) * totalPx;
      const heightPx = Math.max(22, ((visEnd - visStart) / rangeMin) * totalPx);
      const rangeLabel = `${formatHm(clipped.start)}–${formatHm(clipped.end)}`;
      raw.push({ task, visStart, visEnd, topPx, heightPx, rangeLabel });
    }

    const n = raw.length;
    const groups = unionFindOverlapGroups(n, (i, j) =>
      intervalsOverlapMinutes(raw[i].visStart, raw[i].visEnd, raw[j].visStart, raw[j].visEnd),
    );

    const laneByIndex = new Map<number, { laneIndex: number; laneCount: number }>();
    for (const indices of groups) {
      const m = assignLanesInOverlapGroup(raw, indices);
      for (const [idx, v] of m) {
        laneByIndex.set(idx, v);
      }
    }

    const blocks: DayTimelineBlock[] = raw.map((r, i) => {
      const lane = laneByIndex.get(i) ?? { laneIndex: 0, laneCount: 1 };
      return {
        task: r.task,
        topPx: r.topPx,
        heightPx: r.heightPx,
        rangeLabel: r.rangeLabel,
        laneIndex: lane.laneIndex,
        laneCount: Math.max(1, lane.laneCount),
      };
    });

    blocks.sort((a, b) => a.topPx - b.topPx || a.laneIndex - b.laneIndex || b.heightPx - a.heightPx);
    return { blocks };
  }

  /** 表示日が今日のとき、現在時刻の水平線位置（px）。タイムライン内相対。 */
  get dayNowLineTopPx(): number | null {
    if (!this.isToday(this.viewDate)) {
      return null;
    }
    const now = new Date();
    const rangeMin = (this.dayTimelineEndHour - this.dayTimelineStartHour) * 60;
    const totalPx = this.dayTimelineGridHeightPx;
    const minsFromStart =
      (now.getHours() - this.dayTimelineStartHour) * 60 + now.getMinutes() + now.getSeconds() / 60;
    if (minsFromStart < 0 || minsFromStart >= rangeMin) {
      return null;
    }
    return (minsFromStart / rangeMin) * totalPx;
  }

  private viewDayTasksSorted(): Task[] {
    const byDay = this.tasksByDayKey();
    const key = dayKey(this.viewDate);
    const all = byDay.get(key) ?? [];
    return [...all].sort(compareTasksInCell);
  }

  get monthWeeks(): { date: Date; inMonth: boolean; items: Task[]; overflow: number }[][] {
    const vm = new Date(this.viewDate.getFullYear(), this.viewDate.getMonth(), 1);
    const weeks = buildMonthWeeks(vm);
    const byDay = this.tasksByDayKey();
    const ym = vm.getMonth();
    return weeks.map((row) =>
      row.map((date) => {
        const inMonth = date.getMonth() === ym;
        const key = dayKey(date);
        const all = byDay.get(key) ?? [];
        const sorted = [...all].sort(compareTasksInCell);
        const cap = this.maxMonth;
        const items = sorted.slice(0, cap);
        const overflow = Math.max(0, sorted.length - cap);
        return { date, inMonth, items, overflow };
      }),
    );
  }

  get weekDays(): { date: Date; items: Task[]; overflow: number }[] {
    const start = startOfWeekSunday(this.viewDate);
    const byDay = this.tasksByDayKey();
    const out: { date: Date; items: Task[]; overflow: number }[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const key = dayKey(date);
      const all = byDay.get(key) ?? [];
      const sorted = [...all].sort(compareTasksInCell);
      const cap = this.maxWeek;
      const items = sorted.slice(0, cap);
      const overflow = Math.max(0, sorted.length - cap);
      out.push({ date, items, overflow });
    }
    return out;
  }

  /** 締切・開始終了とも未設定のタスク */
  get unscheduledTasks(): Task[] {
    return this.tasks.filter((t) => taskScheduleMode(t) === 'none').sort(compareTasksInCell);
  }

  private tasksByDayKey(): Map<string, Task[]> {
    const map = new Map<string, Task[]>();
    const push = (key: string, t: Task) => {
      const arr = map.get(key);
      if (arr) {
        arr.push(t);
      } else {
        map.set(key, [t]);
      }
    };
    for (const t of this.tasks) {
      const m = taskScheduleMode(t);
      if (m === 'deadline' && t.deadline) {
        const d = t.deadline instanceof Date ? t.deadline : new Date(t.deadline);
        if (Number.isNaN(d.getTime())) {
          continue;
        }
        push(dayKey(d), t);
      } else if (m === 'window' && t.startAt && t.endAt) {
        const s = startOfDay(new Date(t.startAt));
        const e = startOfDay(new Date(t.endAt));
        const cur = new Date(s);
        while (cur.getTime() <= e.getTime()) {
          push(dayKey(cur), t);
          cur.setDate(cur.getDate() + 1);
        }
      }
    }
    return map;
  }

  isToday(d: Date): boolean {
    return sameCalendarDay(d, new Date());
  }

  /** リスト行の `labelStripColor` と同じ（ラベル色の帯・背景トーン用） */
  labelColor(task: Task): string {
    const c = task.label?.trim();
    return c || '#e0e0e0';
  }

  onTaskChipContextMenu(ev: MouseEvent, task: Task): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.taskContextMenu.emit({
      clientX: ev.clientX,
      clientY: ev.clientY,
      task,
    });
  }
}
