import { Component, EventEmitter, Input, Output, inject, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatMenuModule } from '@angular/material/menu';
import { Task } from '../../models/task';
import { TaskScope, taskDetailScopeParam } from '../task-scope';
import { clampTaskPriority } from '../task-priority';
import { saveTaskShellScrollPosition } from '../task-shell-scroll';
import { taskScheduleMode, timestampLikeToDate } from '../task-schedule';
import { TaskCalendarGranularity, TaskCalendarWeekdayStart, MonthWeekRow, MonthWeekGridRangeChip, MonthWeekGridDayChip, MonthWeekCellModel } from './task-calendar.model';
import { CALENDAR_MONTH_MAX_PER_DAY, CALENDAR_WEEK_MAX_PER_DAY, CALENDAR_DAY_MAX, CALENDAR_TIMELINE_LANE_HEIGHT_PX, CALENDAR_DAY_VIEW_LANE_HEIGHT_PX, CALENDAR_DAY_MIN_TIMELINE_TRACK_HEIGHT_PX, CALENDAR_TIMELINE_AXIS_ROW_H_PX, CALENDAR_DAY_TIMELINE_START_HOUR, CALENDAR_DAY_TIMELINE_END_HOUR } from './task-calendar.model';
import { DayDeadlineEntry, DayTimelineBlock } from './task-calendar.model';
export * from './task-calendar.model';

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

/** 開始日と終了日が別カレンダー日のウィンドウ予定 */
function isMultiDayWindowTask(task: Task): boolean {
  if (taskScheduleMode(task) !== 'window') {
    return false;
  }
  const s = timestampLikeToDate(task.startAt);
  const e = timestampLikeToDate(task.endAt);
  if (!s || !e) {
    return false;
  }
  return dayKey(s) !== dayKey(e);
}

/**
 * 月・週の各日セル内：日をまたぐウィンドウ予定を、それ以外より上に並べる。
 * （各グループ内は優先度→タイトル）
 */
function compareTasksInCalendarCell(a: Task, b: Task): number {
  const aSpan = isMultiDayWindowTask(a);
  const bSpan = isMultiDayWindowTask(b);
  if (aSpan !== bSpan) {
    return aSpan ? -1 : 1;
  }
  return compareTasksInCell(a, b);
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

/** 月グリッド用：含まれる月の週×7日（`weekStartsMonday` で左端を月曜 or 日曜に） */
function buildMonthWeeks(viewMonth: Date, weekStartsMonday: boolean): Date[][] {
  const y = viewMonth.getFullYear();
  const m = viewMonth.getMonth();
  const first = new Date(y, m, 1);
  const start = new Date(first);
  const dow = first.getDay();
  if (weekStartsMonday) {
    const offset = dow === 0 ? 6 : dow - 1;
    start.setDate(first.getDate() - offset);
  } else {
    start.setDate(first.getDate() - dow);
  }
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

/** ローカル日 `d` が属する週の開始日（時刻 0:00） */
function startOfCalendarWeek(d: Date, weekStartsMonday: boolean): Date {
  const x = startOfDay(new Date(d));
  const day = x.getDay();
  if (weekStartsMonday) {
    const offset = day === 0 ? 6 : day - 1;
    x.setDate(x.getDate() - offset);
  } else {
    x.setDate(x.getDate() - day);
  }
  return x;
}

@Component({
  selector: 'app-task-calendar',
  standalone: true,
  imports: [CommonModule, FormsModule, MatButtonModule, MatTooltipModule, MatButtonToggleModule, MatDatepickerModule, MatMenuModule],
  templateUrl: './task-calendar.html',
  styleUrl: './task-calendar.css',
})
export class TaskCalendar {
  private readonly router = inject(Router);
  @Input({ required: true }) tasks: Task[] = [];
  @Input({ required: true }) taskScope!: TaskScope;
  @Input() granularity: TaskCalendarGranularity = 'month';

  /** 週の左端（親の localStorage と同期） */
  @Input() weekdayStart: TaskCalendarWeekdayStart = 'Sunday';
  @Output() weekdayStartChange = new EventEmitter<TaskCalendarWeekdayStart>();

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

  /** ツールバー等で日付が変わったとき */
  @Output() viewDateChange = new EventEmitter<Date>();

  /** 月グリッドの日付をクリックしたとき */
  @Output() pickCalendarDay = new EventEmitter<Date>();

  /** チップ／ブロック上の右クリック */
  @Output() taskContextMenu = new EventEmitter<{
    clientX: number;
    clientY: number;
    task: Task;
  }>();

  /** 日表示の右クリック */
  @Output() dayContextMenu = new EventEmitter<{
    clientX: number;
    clientY: number;
    date: Date;
  }>();

  readonly maxMonth = CALENDAR_MONTH_MAX_PER_DAY;
  readonly maxWeek = CALENDAR_WEEK_MAX_PER_DAY;
  readonly maxDay = CALENDAR_DAY_MAX;

  readonly timelineLaneHeightPx = CALENDAR_TIMELINE_LANE_HEIGHT_PX;
  /** 日表示のウィンドウ予定ブロック用レーン高 */
  readonly dayViewLaneHeightPx = CALENDAR_DAY_VIEW_LANE_HEIGHT_PX;
  readonly timelineAxisRowHPx = CALENDAR_TIMELINE_AXIS_ROW_H_PX;
  readonly dayTimelineStartHour = CALENDAR_DAY_TIMELINE_START_HOUR;
  readonly dayTimelineEndHour = CALENDAR_DAY_TIMELINE_END_HOUR;

  /** 横タイムライン上段：0〜23 の時ラベル */
  get dayTimelineHourLabels(): number[] {
    const out: number[] = [];
    for (let h = this.dayTimelineStartHour; h < this.dayTimelineEndHour; h++) {
      out.push(h);
    }
    return out;
  }

  get weekStartsMonday(): boolean {
    return this.weekdayStart === 'Monday';
  }

  /** 列ヘッダー順（左から）：日曜始まりなら日…土、月曜始まりなら月…日 */
  get weekdayLabels(): string[] {
    return this.weekStartsMonday
      ? ['月', '火', '水', '木', '金', '土', '日']
      : ['日', '月', '火', '水', '木', '金', '土'];
  }

  get scopeKind(): string {
    return this.taskScope.kind;
  }

  openMultiCalDialog(): void {
    console.log('openMultiCalDialog');
  }

  /**
   * `weekdayLabels` の列インデックス（0〜6）を返す。`d` の曜日（getDay）と表示列を対応させる。
   */
  weekdayLabelForDate(d: Date): string {
    const i = this.weekStartsMonday ? (d.getDay() + 6) % 7 : d.getDay();
    return this.weekdayLabels[i];
  }

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

  /** 週表示：日付セルをクリック → その日の日表示へ（親が粒度を切り替え） */
  pickWeekDay(date: Date): void {
    const d = startOfDay(new Date(date));
    this._viewDate = d;
    this.pickCalendarDay.emit(new Date(d.getTime()));
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
    const start = startOfCalendarWeek(this.viewDate, this.weekStartsMonday);
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
    return `${d.getFullYear()}年 ${d.getMonth() + 1}月 ${d.getDate()}日（${this.weekdayLabelForDate(d)}）`;
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
   * 一日の締切タスク（内部用・時刻順）。
   * 表示はタイムライン上のラベル色の縦線（`dayDeadlineLines`）。
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

  /** 日表示：締切をタイムライン上の位置（左端%）にマッピング */
  get dayDeadlineLines(): { task: Task; leftPct: number; timeLabel: string }[] {
    return this.deadlineLinesForDate(this.viewDate);
  }

  /** 指定日の締切をタイムライン上の左端%に変換（日・週共通） */
  private deadlineLinesForDate(dayDate: Date): { task: Task; leftPct: number; timeLabel: string }[] {
    const rangeMin = (this.dayTimelineEndHour - this.dayTimelineStartHour) * 60;
    const sod = startOfDay(new Date(dayDate));
    const out: { task: Task; leftPct: number; timeLabel: string }[] = [];
    for (const task of this.tasksForDaySorted(dayDate)) {
      if (taskScheduleMode(task) !== 'deadline') {
        continue;
      }
      const dl = timestampLikeToDate(task.deadline);
      if (!dl || !sameCalendarDay(dl, dayDate)) {
        continue;
      }
      const minsFromStart =
        (dl.getTime() - sod.getTime()) / 60000 - this.dayTimelineStartHour * 60;
      if (minsFromStart < 0 || minsFromStart >= rangeMin) {
        continue;
      }
      out.push({
        task,
        leftPct: (minsFromStart / rangeMin) * 100,
        timeLabel: formatHm(dl),
      });
    }
    out.sort((a, b) => {
      const ta = timestampLikeToDate(a.task.deadline)?.getTime() ?? 0;
      const tb = timestampLikeToDate(b.task.deadline)?.getTime() ?? 0;
      return ta - tb;
    });
    return out;
  }

  get dayTimeline(): { blocks: DayTimelineBlock[]; trackHeightPx: number } {
    const { blocks, trackHeightPx } = this.computeHorizontalTimeline(
      this.viewDate,
      CALENDAR_DAY_VIEW_LANE_HEIGHT_PX,
    );
    return {
      blocks,
      trackHeightPx: Math.max(trackHeightPx, CALENDAR_DAY_MIN_TIMELINE_TRACK_HEIGHT_PX),
    };
  }

  /** 日表示：現在時刻の位置（左端からの%） */
  get dayNowLineLeftPct(): number | null {
    return this.nowLineLeftPctForDate(this.viewDate);
  }

  /**
   * 週表示：各日 1 行の横タイムライン（日表示と同ロジック）。
   */
  get weekTimelineRows(): Array<{
    date: Date;
    blocks: DayTimelineBlock[];
    trackHeightPx: number;
    nowLineLeftPct: number | null;
    deadlineLines: { task: Task; leftPct: number; timeLabel: string }[];
  }> {
    const start = startOfCalendarWeek(this.viewDate, this.weekStartsMonday);
    const rows: Array<{
      date: Date;
      blocks: DayTimelineBlock[];
      trackHeightPx: number;
      nowLineLeftPct: number | null;
      deadlineLines: { task: Task; leftPct: number; timeLabel: string }[];
    }> = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(start);
      date.setDate(start.getDate() + i);
      const tl = this.computeHorizontalTimeline(date);
      rows.push({
        date,
        blocks: tl.blocks,
        trackHeightPx: tl.trackHeightPx,
        nowLineLeftPct: this.nowLineLeftPctForDate(date),
        deadlineLines: this.deadlineLinesForDate(date),
      });
    }
    return rows;
  }

  private nowLineLeftPctForDate(dayDate: Date): number | null {
    if (!this.isToday(dayDate)) {
      return null;
    }
    const rangeMin = (this.dayTimelineEndHour - this.dayTimelineStartHour) * 60;
    const now = new Date();
    const minsFromStart =
      (now.getHours() - this.dayTimelineStartHour) * 60 + now.getMinutes() + now.getSeconds() / 60;
    if (minsFromStart < 0 || minsFromStart >= rangeMin) {
      return null;
    }
    return (minsFromStart / rangeMin) * 100;
  }

  private computeHorizontalTimeline(
    dayDate: Date,
    laneHeightPx: number = CALENDAR_TIMELINE_LANE_HEIGHT_PX,
  ): {
    blocks: DayTimelineBlock[];
    trackHeightPx: number;
  } {
    const sorted = this.tasksForDaySorted(dayDate);
    const rangeMin = (this.dayTimelineEndHour - this.dayTimelineStartHour) * 60;
    const sod = startOfDay(new Date(dayDate));

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
      const clipped = clipIntervalToCalendarDay(dayDate, s, e);
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
      const rangeLabel = `${formatHm(clipped.start)}–${formatHm(clipped.end)}`;
      raw.push({ task, visStart, visEnd, rangeLabel });
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
      const visStart = r.visStart;
      const visEnd = r.visEnd;
      const leftPct = (visStart / rangeMin) * 100;
      const widthPct = Math.max(
        0.35,
        ((Math.min(visEnd, rangeMin) - Math.max(0, visStart)) / rangeMin) * 100,
      );
      return {
        task: r.task,
        rangeLabel: r.rangeLabel,
        leftPct,
        widthPct,
        laneIndex: lane.laneIndex,
        laneCount: Math.max(1, lane.laneCount),
      };
    });

    blocks.sort(
      (a, b) => a.leftPct - b.leftPct || a.laneIndex - b.laneIndex || b.widthPct - a.widthPct,
    );

    const maxLanes = blocks.length === 0 ? 1 : Math.max(...blocks.map((b) => b.laneCount), 1);
    const trackHeightPx = maxLanes * laneHeightPx;
    return { blocks, trackHeightPx };
  }

  private tasksForDaySorted(day: Date): Task[] {
    const key = dayKey(day);
    const all = this.tasksByDayKey().get(key) ?? [];
    return [...all].sort(compareTasksInCalendarCell);
  }

  private viewDayTasksSorted(): Task[] {
    return this.tasksForDaySorted(this.viewDate);
  }

  /**
   * 月表示：週を 5 行×7 列の CSS Grid で表現する。
   * 複数日ウィンドウは複数列にまたがる 1 チップ、単日はその日の列で複数日に使われていない行に積む。
   */
  get monthWeekRows(): MonthWeekRow[] {
    const vm = new Date(this.viewDate.getFullYear(), this.viewDate.getMonth(), 1);
    const weeks = buildMonthWeeks(vm, this.weekStartsMonday);
    const byDay = this.tasksByDayKey();
    const ym = vm.getMonth();
    const maxRows = this.maxMonth;
    const multiDayTasks = this.tasks.filter(isMultiDayWindowTask);

    return weeks.map((weekDates, weekIndex) => {
      const segmentsRaw: { task: Task; colStart: number; colEnd: number }[] = [];
      for (const task of multiDayTasks) {
        const s = timestampLikeToDate(task.startAt);
        const e = timestampLikeToDate(task.endAt);
        if (!s || !e) {
          continue;
        }
        const sd = startOfDay(s);
        const ed = startOfDay(e);
        let colStart = -1;
        let colEnd = -1;
        for (let i = 0; i < 7; i++) {
          const d = startOfDay(weekDates[i]);
          if (d.getTime() >= sd.getTime() && d.getTime() <= ed.getTime()) {
            if (colStart === -1) {
              colStart = i;
            }
            colEnd = i;
          }
        }
        if (colStart === -1) {
          continue;
        }
        segmentsRaw.push({ task, colStart, colEnd });
      }

      segmentsRaw.sort((a, b) => {
        if (a.colStart !== b.colStart) {
          return a.colStart - b.colStart;
        }
        const wa = a.colEnd - a.colStart;
        const wb = b.colEnd - b.colStart;
        if (wa !== wb) {
          return wb - wa;
        }
        return compareTasksInCell(a.task, b.task);
      });

      const occupied: { colStart: number; colEnd: number }[][] = [];
      const rangeChips: MonthWeekGridRangeChip[] = [];
      for (const raw of segmentsRaw) {
        let placed = false;
        for (let lane = 0; lane < maxRows; lane++) {
          const ranges = occupied[lane] ?? [];
          const noOverlap = ranges.every(
            (x) => raw.colEnd < x.colStart || raw.colStart > x.colEnd,
          );
          if (noOverlap) {
            if (!occupied[lane]) {
              occupied[lane] = [];
            }
            occupied[lane].push({ colStart: raw.colStart, colEnd: raw.colEnd });
            rangeChips.push({
              task: raw.task,
              lane,
              colStart: raw.colStart,
              colEnd: raw.colEnd,
              gridColumn: `${raw.colStart + 1} / ${raw.colEnd + 2}`,
              trackId: `${raw.task.id ?? raw.task.title}-w${weekIndex}-L${lane}-${raw.colStart}-${raw.colEnd}`,
            });
            placed = true;
            break;
          }
        }
        if (!placed) {
          /* 5 行に収まらない複数日帯は表示しない */
        }
      }

      const dayChips: MonthWeekGridDayChip[] = [];
      const cells: MonthWeekCellModel[] = [];

      for (let col = 0; col < 7; col++) {
        const date = weekDates[col];
        const inMonth = date.getMonth() === ym;
        const key = dayKey(date);
        const all = byDay.get(key) ?? [];
        const sorted = [...all].sort(compareTasksInCalendarCell);

        const occupiedLanes = new Set<number>();
        for (const rc of rangeChips) {
          if (rc.colStart <= col && col <= rc.colEnd) {
            occupiedLanes.add(rc.lane);
          }
        }
        const freeRows = [0, 1, 2, 3, 4].filter((r) => !occupiedLanes.has(r));
        const singleDay = sorted.filter((t) => !isMultiDayWindowTask(t));
        const nShow = Math.min(freeRows.length, singleDay.length);
        for (let i = 0; i < nShow; i++) {
          const t = singleDay[i];
          const row = freeRows[i];
          dayChips.push({
            task: t,
            col,
            row,
            trackId: `d${weekIndex}-${col}-r${row}-${t.id ?? t.title}`,
          });
        }
        const overflow = Math.max(0, singleDay.length - nShow);
        cells.push({ date, inMonth, overflow });
      }

      return {
        cells,
        rangeChips,
        dayChips,
        trackKey: startOfDay(weekDates[0]).getTime(),
      };
    });
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

  onDayContextMenu(ev: MouseEvent, date: Date): void {
    ev.preventDefault();
    ev.stopPropagation();
    const now = new Date();
    const baseDate = new Date(date);
    baseDate.setHours(now.getHours())
    baseDate.setMinutes(now.getMinutes())
    baseDate.setSeconds(now.getSeconds())
    baseDate.setMilliseconds(now.getMilliseconds())
    this.dayContextMenu.emit({
      clientX: ev.clientX,
      clientY: ev.clientY,
      date: baseDate,
    });
  }
}
