import { Task } from '../../models/task';

/** 月表示：同一日付に並べるタスクの最大数 */
export const CALENDAR_MONTH_MAX_PER_DAY = 5;
/** 週表示：タイムラインに載せるウィンドウ予定の上限（日あたり、実質はレーン数に依存） */
export const CALENDAR_WEEK_MAX_PER_DAY = 80;
/** 一日表示：表示するタスクの最大数（タイムライン外のオーバーフロー表示用） */
export const CALENDAR_DAY_MAX = 80;

/** 横タイムライン：時間軸ラベル行の高さ（px） */
export const CALENDAR_TIMELINE_AXIS_ROW_H_PX = 28;
/** 横タイムライン：重なりを縦に積む 1 レーンの高さ（px）— 週表示など */
export const CALENDAR_TIMELINE_LANE_HEIGHT_PX = 34;
/** 日表示のみ：レーン高（週の約2倍） */
export const CALENDAR_DAY_VIEW_LANE_HEIGHT_PX = 72;
/** 日表示：タイムライン帯の最小高さ（px）— 空でも十分な高さを確保 */
export const CALENDAR_DAY_MIN_TIMELINE_TRACK_HEIGHT_PX = 320;
/** 表示する時間帯（0〜24 時未満） */
export const CALENDAR_DAY_TIMELINE_START_HOUR = 0;
export const CALENDAR_DAY_TIMELINE_END_HOUR = 24;

/** 月セル：チップ 1 段の高さ（px）・5 段分でセル高を固定 */
export const CALENDAR_MONTH_TASK_CHIP_H_PX = 20;
export const CALENDAR_MONTH_TASK_GAP_PX = 2;

/** 一日の「締切」枠：締切日時の早い順 */
export interface DayDeadlineEntry {
  task: Task;
  at: Date;
  timeLabel: string;
}

export interface DayTimelineBlock {
  task: Task;
  rangeLabel: string;
  /** 当日レンジ内の左端（0〜100%） */
  leftPct: number;
  /** 幅（0〜100%） */
  widthPct: number;
  /** 重なりグループ内の段（0 ＝ 上） */
  laneIndex: number;
  /** 同じ重なりグループ内の段数 */
  laneCount: number;
}

/** カレンダー粒度（TaskList の `calendarGranularity` と共有） */
export type TaskCalendarGranularity = 'month' | 'week' | 'day';

/** 週の左端（月グリッド・週タイムラインの列順） */
export type TaskCalendarWeekdayStart = 'Sunday' | 'Monday';

/** 月表示：日セル用（オーバーレイは {@link MonthWeekRow} の週グリッド） */
export interface MonthWeekCellModel {
  date: Date;
  inMonth: boolean;
  /** 単日タスクのうち 5 行グリッドに載せきれない件数 */
  overflow: number;
}

/** 月表示：複数日ウィンドウを週グリッドの 1 行にまたがって表示するチップ */
export interface MonthWeekGridRangeChip {
  task: Task;
  /** 週内列 0〜6 に対応するグリッド行（0 ＝ 上段） */
  lane: number;
  colStart: number;
  colEnd: number;
  gridColumn: string;
  trackId: string;
}

/** 月表示：単日タスクのグリッド配置（列・行は 0 始まり） */
export interface MonthWeekGridDayChip {
  task: Task;
  col: number;
  row: number;
  trackId: string;
}

/** 月表示：1 週（5 行×7 列のタスクグリッド＋日付行は別レイヤ） */
export interface MonthWeekRow {
  cells: MonthWeekCellModel[];
  rangeChips: MonthWeekGridRangeChip[];
  dayChips: MonthWeekGridDayChip[];
  trackKey: number;
}