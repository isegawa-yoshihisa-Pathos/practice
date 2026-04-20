import {
  Component,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TaskListItem } from '../task-list-item/task-list-item';
import { Task } from '../../models/task';
import {
  firestoreStatusFields,
  nextTaskStatus,
  normalizeTaskStatusFromDoc,
  type TaskStatus,
} from '../../models/task-status';
import { clampTaskPriority } from '../task-priority';
import { sortTasks, TaskSortField } from '../task-sort';
import {
  colorFilterOptions,
  defaultTaskFilterState,
  DueDateFilter,
  filterTasks,
  isFilterDefaultForReorder,
  TaskFilterState,
} from '../task-filter';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatRadioModule } from '@angular/material/radio';
import { MatDialog, MatDialogModule } from '@angular/material/dialog';
import { TaskFormDialog } from '../task-form-dialog/task-form-dialog';
import { TaskDuplicateDialog } from '../task-duplicate-dialog/task-duplicate-dialog';
import {
  Firestore,
  collection,
  addDoc,
  doc,
  Timestamp,
  serverTimestamp,
  collectionData,
  writeBatch,
  updateDoc,
  getDoc,
  setDoc,
  docData,
} from '@angular/fire/firestore';
import { map } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import { AuthService } from '../auth.service';
import { TaskScope, taskDetailScopeParam, taskListViewStorageKey } from '../task-scope';
import { saveTaskShellScrollPosition } from '../task-shell-scroll';
import type { ProjectMemberRow } from '../../models/project-member';
import {
  TaskCalendar,
  type TaskCalendarGranularity,
  type TaskCalendarWeekdayStart,
} from '../task-calendar/task-calendar';
import { UserAvatar } from '../user-avatar/user-avatar';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatCheckboxChange, MatCheckboxModule } from '@angular/material/checkbox';
import { TASK_RETURN_QUERY } from '../task-return-query';
import { ProjectSessionService } from '../project-session.service';
import { timestampLikeToDate } from '../task-schedule';
import {
  DEFAULT_KANBAN_COLUMNS,
  type KanbanColumn,
} from '../../models/kanban-column';
import { TASK_STATUS_OPTIONS } from '../../models/task-status';
import { TaskActivityLogService } from '../task-activity-log.service';
import { taskStatusTransitionPatch } from '../task-firestore-mutation';

@Component({
  selector: 'app-task-list',
  imports: [
    CommonModule,
    FormsModule,
    TaskListItem,
    TaskCalendar,
    DragDropModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatTooltipModule,
    MatFormFieldModule,
    MatSelectModule,
    MatRadioModule,
    MatDialogModule,
    MatMenuModule,
    MatCheckboxModule,
    UserAvatar,
  ],
  templateUrl: './task-list.html',
  styleUrl: './task-list.css',
})
export class TaskList implements OnInit, OnDestroy, OnChanges {
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private readonly dialog = inject(MatDialog);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly projectSession = inject(ProjectSessionService);
  private readonly taskActivityLog = inject(TaskActivityLogService);
  private sub?: Subscription;
  private kanbanBoardSub?: Subscription;

  @Input() taskScope: TaskScope = { kind: 'private', privateListId: 'default' };

  /** リスト表示 / カレンダー / カンバン */
  viewMode: 'list' | 'calendar' | 'kanban' = 'list';
  /** カレンダー時の月／週／日 */
  calendarGranularity: TaskCalendarGranularity = 'month';
  /** カレンダーの基準日（月の表示月・週の週・日のその日） */
  calendarViewDate = new Date();
  /** 月・週表示の週の左端（日曜 / 月曜） */
  calendarWeekdayStart: TaskCalendarWeekdayStart = 'Sunday';

  tasks: Task[] = [];

  /** プロジェクトのメンバー（担当者選択・フィルタ用） */
  projectMembers: ProjectMemberRow[] = [];
  private membersSub?: Subscription;

  /** 未選択は null（ソート条件から除外） */
  sortKey1: TaskSortField | null = null;
  sortKey2: TaskSortField | null = null;
  sortKey3: TaskSortField | null = null;
  sortAscending = true;

  filterState: TaskFilterState = defaultTaskFilterState();

  readonly sortFieldOptions: { value: TaskSortField; label: string }[] = [
    { value: 'color', label: '色' },
    { value: 'deadline', label: '締切日時' },
    { value: 'priority', label: '優先度' },
    { value: 'status', label: '進捗' },
  ];

  /** 進捗フィルタ（未着手 / 処理中 / 完了） */
  readonly statusFilterOptions = TASK_STATUS_OPTIONS;

  readonly dueDateFilterOptions: { value: DueDateFilter; label: string }[] = [
    { value: 'all', label: '締切/予定: すべて' },
    { value: 'overdue', label: '期限切れ（未完了）' },
    { value: 'today', label: '今日が期限' },
    { value: 'within_7', label: '7日以内' },
    { value: 'within_30', label: '30日以内' },
    { value: 'beyond_30', label: '31日以降' },
    { value: 'no_deadline', label: '締切・予定なし' },
  ];

  readonly priorityFilterValues = [5, 4, 3, 2, 1] as const;

  /** Firestore と同期するカンバン列（進捗とは独立） */
  kanbanColumnList: KanbanColumn[] = [...DEFAULT_KANBAN_COLUMNS];

  /** 単一 mat-menu 用（編集ボタンでセット） */
  kanbanEditColumn: KanbanColumn | null = null;

  @ViewChild('taskCtxMenuTrigger') taskCtxMenuTrigger?: MatMenuTrigger;
  contextMenuX = 0;
  contextMenuY = 0;
  ctxTask: Task | null = null;
  /** 右クリック一括メニュー用（2件以上選択かつ対象行が選択内） */
  ctxBulkMode = false;
  ctxBulkIds: string[] = [];
  /** リスト複数選択 */
  private selectedTaskIdSet = new Set<string>();

  /** フィルタのスウォッチ用。チャート外の #RRGGBB もその色で表示 */
  labelCssForFilter(hex: string): string {
    const t = hex?.trim() ?? '';
    if (/^#[0-9A-Fa-f]{6}$/.test(t)) {
      return t;
    }
    return '#bdbdbd';
  }

  resetFilters(): void {
    this.filterState = defaultTaskFilterState();
  }

  get isProjectScope(): boolean {
    return this.taskScope.kind === 'project';
  }

  /** 担当者フィルタの選択行（トリガー表示用） */
  filterSelectedMember(): ProjectMemberRow | null {
    const id = this.filterState.assignee;
    if (id === 'all' || id === 'unassigned') {
      return null;
    }
    return this.projectMembers.find((m) => m.userId === id) ?? null;
  }

  /** 色フィルタの候補（チャート＋タスクに含まれるその他の色） */
  get colorOptionsForFilter(): string[] {
    return colorFilterOptions(this.tasks);
  }

  /** フィルタ適用後のタスク（親子含む） */
  private filterScopeTasks(): Task[] {
    const now = new Date();
    return filterTasks(this.tasks, this.filterState, now, this.isProjectScope);
  }

  /** リスト用の並びキー */
  private listOrderNum(t: Task): number {
    const v = t.listOrderIndex;
    return typeof v === 'number' && !Number.isNaN(v) ? v : Number.MAX_SAFE_INTEGER;
  }

  /** カンバン用の並びキー */
  private kanbanOrderNum(t: Task): number {
    const v = t.kanbanOrderIndex;
    return typeof v === 'number' && !Number.isNaN(v) ? v : Number.MAX_SAFE_INTEGER;
  }

  /**
   * リスト・カレンダー用：ルートタスクのみ（子は親の下に別表示／カレンダーでは非表示）
   */
  get displayRootTasks(): Task[] {
    const keys = [this.sortKey1, this.sortKey2, this.sortKey3].filter(
      (k): k is TaskSortField => k !== null,
    );
    const filtered = this.filterScopeTasks().filter((t) => !t.parentTaskId);
    if (keys.length === 0) {
      return [...filtered].sort((a, b) => {
        const oa = this.listOrderNum(a);
        const ob = this.listOrderNum(b);
        if (oa !== ob) {
          return oa - ob;
        }
        return (a.title ?? '').localeCompare(b.title ?? '');
      });
    }
    return sortTasks(filtered, keys, this.sortAscending);
  }

  /** リスト展開：同一親の子（リスト順のみ） */
  subtasksForParentList(parentId: string): Task[] {
    const filtered = this.filterScopeTasks().filter((t) => t.parentTaskId === parentId);
    return [...filtered].sort((a, b) => {
      const c = this.listOrderNum(a) - this.listOrderNum(b);
      if (c !== 0) {
        return c;
      }
      return (a.title ?? '').localeCompare(b.title ?? '');
    });
  }

  /** カンバン展開：同一親の子（カンバン順のみ） */
  subtasksForParentKanban(parentId: string): Task[] {
    const filtered = this.filterScopeTasks().filter((t) => t.parentTaskId === parentId);
    return [...filtered].sort((a, b) => {
      const c = this.kanbanOrderNum(a) - this.kanbanOrderNum(b);
      if (c !== 0) {
        return c;
      }
      return (a.title ?? '').localeCompare(b.title ?? '');
    });
  }

  /** 親が子を持つ（フィルタ後に1件以上） */
  hasChildTasks(parentId: string | undefined): boolean {
    if (!parentId) {
      return false;
    }
    return this.filterScopeTasks().some((t) => t.parentTaskId === parentId);
  }

  /** リスト／カンバンで子行の展開状態（親タスク ID） */
  expandedSubtaskParentIds = new Set<string>();

  toggleSubtasksExpanded(parentId: string): void {
    const next = new Set(this.expandedSubtaskParentIds);
    if (next.has(parentId)) {
      next.delete(parentId);
    } else {
      next.add(parentId);
    }
    this.expandedSubtaskParentIds = next;
  }

  isSubtasksExpanded(parentId: string | undefined): boolean {
    return !!parentId && this.expandedSubtaskParentIds.has(parentId);
  }

  onSubtasksToggleForListItem(task: Task): void {
    const id = task.id;
    if (!id) {
      return;
    }
    if (this.hasChildTasks(id)) {
      this.toggleSubtasksExpanded(id);
    } else {
      this.openSubtaskDialog(task);
    }
  }

  /** リスト用：ルート行と展開された子行をフラットに（ドラッグ検証用） */
  private visibleListRows(): { kind: 'root' | 'sub'; task: Task; parentId?: string }[] {
    const out: { kind: 'root' | 'sub'; task: Task; parentId?: string }[] = [];
    for (const t of this.displayRootTasks) {
      out.push({ kind: 'root', task: t });
      const id = t.id;
      if (id && this.isSubtasksExpanded(id)) {
        for (const s of this.subtasksForParentList(id)) {
          out.push({ kind: 'sub', task: s, parentId: id });
        }
      }
    }
    return out;
  }

  private isValidListRowOrder(
    rows: { kind: 'root' | 'sub'; task: Task; parentId?: string }[],
  ): boolean {
    let currentRootId: string | null = null;
    for (const r of rows) {
      if (r.kind === 'root') {
        currentRootId = r.task.id ?? null;
      } else {
        if (!currentRootId || r.parentId !== currentRootId) {
          return false;
        }
      }
    }
    return true;
  }

  /** フィルタ初期・並び替え条件なしのときだけ手動ドラッグを有効にする */
  get canReorder(): boolean {
    return (
      this.viewMode === 'list' &&
      isFilterDefaultForReorder(this.filterState, this.isProjectScope) &&
      this.sortKey1 === null &&
      this.sortKey2 === null &&
      this.sortKey3 === null
    );
  }

  trackByTaskId(_index: number, task: Task): string {
    return task.id ?? `idx-${_index}`;
  }

  ngOnInit() {
    /** 表示は常にタブ（taskScope）別 localStorage のみ。URL はグローバルなので初期表示に使わない。 */
    this.loadViewPrefsFromStorage();
    this.onTaskListViewUiChange();

    this.subscribeTasks();
    this.subscribeProjectMembers();
    void this.subscribeKanbanBoard();
  }

  private scopeStorageKey(scope: TaskScope): string {
    return taskListViewStorageKey(scope);
  }

  /** タブ切り替え直前に、離れるタブの表示を保存 */
  private persistViewPrefsForLeavingScope(scope: TaskScope): void {
    this.projectSession.setTaskListViewPref(this.scopeStorageKey(scope), {
      viewMode: this.viewMode,
      calendarGranularity: this.calendarGranularity,
      calendarViewDateIso: this.calendarViewDate.toISOString(),
      calendarWeekdayStart: this.calendarWeekdayStart,
    });
  }

  private loadViewPrefsFromStorage(): void {
    const pref = this.projectSession.getTaskListViewPref(this.scopeStorageKey(this.taskScope));
    if (!pref) {
      this.viewMode = 'list';
      this.calendarGranularity = 'month';
      this.calendarViewDate = new Date();
      this.calendarWeekdayStart = 'Sunday';
      return;
    }
    this.viewMode = pref.viewMode;
    this.calendarGranularity = pref.calendarGranularity;
    const d = new Date(pref.calendarViewDateIso);
    this.calendarViewDate = Number.isNaN(d.getTime()) ? new Date() : d;
    this.calendarWeekdayStart =
      pref.calendarWeekdayStart === 'Monday' ? 'Monday' : 'Sunday';
  }

  private persistCurrentViewPrefsToStorage(): void {
    this.projectSession.setTaskListViewPref(this.scopeStorageKey(this.taskScope), {
      viewMode: this.viewMode,
      calendarGranularity: this.calendarGranularity,
      calendarViewDateIso: this.calendarViewDate.toISOString(),
      calendarWeekdayStart: this.calendarWeekdayStart,
    });
  }

  onCalendarViewDateChange(d: Date): void {
    this.calendarViewDate = d;
    this.onTaskListViewUiChange();
  }

  onCalendarWeekdayStartChange(v: TaskCalendarWeekdayStart): void {
    this.calendarWeekdayStart = v;
    this.onTaskListViewUiChange();
  }

  /** 月表示の日付クリック → その日の日表示 */
  onPickCalendarDayFromMonth(d: Date): void {
    this.calendarViewDate = d;
    this.calendarGranularity = 'day';
    this.onTaskListViewUiChange();
  }

  isTaskSelected(taskId: string | undefined): boolean {
    return !!taskId && this.selectedTaskIdSet.has(taskId);
  }

  /**　親タスクの選択を変更すると子タスクの選択も変更される */
  onTaskSelectionChange(task: Task, selected: boolean): void {
    const id = task.id;
    if (!id) {
      return;
    }
    const subtree = this.collectSubtreeIds(id);
    const next = new Set(this.selectedTaskIdSet);
    if (selected) {
      for (const x of subtree) {
        next.add(x);
      }
    } else {
      for (const x of subtree) {
        next.delete(x);
      }
    }
    this.selectedTaskIdSet = next;
  }

  private clearTaskSelection(): void {
    this.selectedTaskIdSet = new Set();
  }

  /** リストに表示中の行（ルート＋展開中の子）の ID */
  listSelectableTaskIds(): string[] {
    const ids: string[] = [];
    for (const t of this.displayRootTasks) {
      if (t.id) {
        ids.push(t.id);
      }
      const pid = t.id;
      if (pid && this.isSubtasksExpanded(pid)) {
        for (const st of this.subtasksForParentList(pid)) {
          if (st.id) {
            ids.push(st.id);
          }
        }
      }
    }
    return ids;
  }

  /** カンバンに表示中のカード（全列のルート＋展開中の子）の ID */
  kanbanSelectableTaskIds(): string[] {
    const ids: string[] = [];
    for (const col of this.kanbanColumnList) {
      for (const t of this.tasksForKanbanColumnId(col.id)) {
        if (t.id) {
          ids.push(t.id);
        }
        const pid = t.id;
        if (pid && this.isSubtasksExpanded(pid)) {
          for (const st of this.subtasksForParentKanban(pid)) {
            if (st.id) {
              ids.push(st.id);
            }
          }
        }
      }
    }
    return ids;
  }

  /** リスト／カンバン一括選択用 */
  selectableTaskIdsForBulk(): string[] {
    if (this.viewMode === 'kanban') {
      return this.kanbanSelectableTaskIds();
    }
    if (this.viewMode === 'list') {
      return this.listSelectableTaskIds();
    }
    return [];
  }

  isAllVisibleSelected(): boolean {
    const visible = this.selectableTaskIdsForBulk();
    if (visible.length === 0) {
      return false;
    }
    return visible.every((id) => this.selectedTaskIdSet.has(id));
  }

  isSomeVisibleSelected(): boolean {
    const visible = this.selectableTaskIdsForBulk();
    return visible.some((id) => this.selectedTaskIdSet.has(id));
  }

  onBulkSelectCheckboxChange(ev: MatCheckboxChange): void {
    if (ev.checked) {
      const next = new Set(this.selectedTaskIdSet);
      for (const id of this.selectableTaskIdsForBulk()) {
        next.add(id);
      }
      this.selectedTaskIdSet = next;
    } else {
      this.clearTaskSelection();
    }
  }

  /** ユーザーがリスト/カレンダー/カンバンを切り替えたとき URL と localStorage を同期 */
  onTaskListViewUiChange(): void {
    if (this.viewMode !== 'list') {
      this.clearTaskSelection();
    }
    this.persistCurrentViewPrefsToStorage();
    const queryParams: Record<string, string | null> = {
      [TASK_RETURN_QUERY.taskView]: this.viewMode,
      [TASK_RETURN_QUERY.cal]:
        this.viewMode === 'calendar' ? this.calendarGranularity : null,
    };
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams,
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['taskScope']) {
      const ch = changes['taskScope'];
      if (!ch.firstChange && ch.previousValue) {
        this.persistViewPrefsForLeavingScope(ch.previousValue as TaskScope);
        this.loadViewPrefsFromStorage();
        this.onTaskListViewUiChange();
      }
      if (!ch.firstChange) {
        this.subscribeTasks();
        this.subscribeProjectMembers();
        void this.subscribeKanbanBoard();
        if (!this.isProjectScope) {
          this.filterState = { ...this.filterState, assignee: 'all' };
        }
      }
    }
  }

  private subscribeProjectMembers(): void {
    this.membersSub?.unsubscribe();
    this.membersSub = undefined;
    this.projectMembers = [];
    if (this.taskScope.kind !== 'project') {
      return;
    }
    const pid = this.taskScope.projectId;
    const ref = collection(this.firestore, 'projects', pid, 'members');
    this.membersSub = collectionData(ref, { idField: 'id' })
      .pipe(
        map((rows) =>
          (rows as Record<string, unknown>[]).map((data) => {
            const id = String(data['id'] ?? '');
            const displayName =
              typeof data['displayName'] === 'string' && data['displayName'].trim() !== ''
                ? data['displayName'].trim()
                : typeof data['username'] === 'string' && data['username'].trim() !== ''
                  ? data['username'].trim()
                  : id;
            const avatarUrl =
              typeof data['avatarUrl'] === 'string' && data['avatarUrl'].trim() !== ''
                ? data['avatarUrl'].trim()
                : null;
            return { userId: id, displayName, avatarUrl };
          }),
        ),
      )
      .subscribe((members) => {
        this.projectMembers = members.filter((m) => m.userId);
      });
  }

  private subscribeTasks() {
    this.sub?.unsubscribe();
    this.sub = undefined;
    this.tasks = [];

    const userId = this.auth.userId();
    if (!userId) {
      return;
    }

    const ref = this.tasksCollectionRef(userId);

    this.sub = collectionData(ref, { idField: 'id' })
      .pipe(
        map((rows) =>
          (rows as Record<string, unknown>[]).map((data) => {
            const status = normalizeTaskStatusFromDoc(data as Record<string, unknown>);
            const label =
              typeof data['label'] === 'string' && data['label'].trim() !== ''
                ? data['label']
                : '';
            const deadline = timestampLikeToDate(data['deadline']);
            const startAt = timestampLikeToDate(data['startAt']);
            const endAt = timestampLikeToDate(data['endAt']);
            const description =
              typeof data['description'] === 'string' ? data['description'] : '';
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
              typeof rawParent === 'string' && rawParent.trim() !== ''
                ? rawParent.trim()
                : null;
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
          }),
        ),
      )
      .subscribe((tasks) => {
        this.tasks = tasks;
      });
  }

  addTask(task: Task) {
    const userId = this.auth.userId();
    if (!userId) {
      return;
    }
    const col = this.tasksCollectionRef(userId);
    const payload: Record<string, unknown> = {
      title: task.title,
      label: task.label,
      ...firestoreStatusFields(task.status),
      priority: task.priority,
      description: task.description ?? '',
    };
    if (task.deadline) {
      payload['deadline'] = Timestamp.fromDate(new Date(task.deadline));
      payload['startAt'] = null;
      payload['endAt'] = null;
    } else if (task.startAt && task.endAt) {
      payload['deadline'] = null;
      payload['startAt'] = Timestamp.fromDate(new Date(task.startAt));
      payload['endAt'] = Timestamp.fromDate(new Date(task.endAt));
    } else {
      payload['deadline'] = null;
      payload['startAt'] = null;
      payload['endAt'] = null;
    }
    if (this.taskScope.kind === 'project') {
      const a = typeof task.assignee === 'string' ? task.assignee.trim() : '';
      payload['assignee'] = a || null;
    }
    const firstCol = this.kanbanColumnList[0]?.id;
    if (firstCol) {
      payload['kanbanColumnId'] = firstCol;
    }
    const roots = this.tasks.filter((t) => !t.parentTaskId);
    let maxList = -1;
    let maxKb = -1;
    for (const t of roots) {
      const l = t.listOrderIndex;
      if (typeof l === 'number' && !Number.isNaN(l)) {
        maxList = Math.max(maxList, l);
      }
      const k = t.kanbanOrderIndex;
      if (typeof k === 'number' && !Number.isNaN(k)) {
        maxKb = Math.max(maxKb, k);
      }
    }
    const nextList = maxList < 0 ? 0 : maxList + 1000;
    const nextKb = maxKb < 0 ? 0 : maxKb + 1000;
    payload['listOrderIndex'] = nextList;
    payload['kanbanOrderIndex'] = nextKb;
    payload['createdAt'] = serverTimestamp();
    payload['updatedAt'] = serverTimestamp();
    void addDoc(col, payload).then((docRef) =>
      this.taskActivityLog.logCreate(this.taskScope, {
        subjectId: docRef.id,
        subjectTitle: task.title,
      }),
    );
  }

  addSubtask(parent: Task, task: Task): void {
    const userId = this.auth.userId();
    const parentId = parent.id;
    if (!userId || !parentId) {
      return;
    }
    const col = this.tasksCollectionRef(userId);
    const payload: Record<string, unknown> = {
      title: task.title,
      label: task.label,
      ...firestoreStatusFields(task.status),
      priority: task.priority,
      description: task.description ?? '',
      parentTaskId: parentId,
    };
    if (task.deadline) {
      payload['deadline'] = Timestamp.fromDate(new Date(task.deadline));
      payload['startAt'] = null;
      payload['endAt'] = null;
    } else if (task.startAt && task.endAt) {
      payload['deadline'] = null;
      payload['startAt'] = Timestamp.fromDate(new Date(task.startAt));
      payload['endAt'] = Timestamp.fromDate(new Date(task.endAt));
    } else {
      payload['deadline'] = null;
      payload['startAt'] = null;
      payload['endAt'] = null;
    }
    if (this.taskScope.kind === 'project') {
      const a = typeof task.assignee === 'string' ? task.assignee.trim() : '';
      payload['assignee'] = a || null;
    }
    const pCol = this.columnIdForTask(parent);
    payload['kanbanColumnId'] = pCol;
    const siblings = this.tasks.filter((t) => t.parentTaskId === parentId);
    let maxList = -1;
    let maxKb = -1;
    for (const t of siblings) {
      const l = t.listOrderIndex;
      if (typeof l === 'number' && !Number.isNaN(l)) {
        maxList = Math.max(maxList, l);
      }
      const k = t.kanbanOrderIndex;
      if (typeof k === 'number' && !Number.isNaN(k)) {
        maxKb = Math.max(maxKb, k);
      }
    }
    const nextList = maxList < 0 ? 0 : maxList + 1000;
    const nextKb = maxKb < 0 ? 0 : maxKb + 1000;
    payload['listOrderIndex'] = nextList;
    payload['kanbanOrderIndex'] = nextKb;
    payload['createdAt'] = serverTimestamp();
    payload['updatedAt'] = serverTimestamp();
    void addDoc(col, payload).then((docRef) =>
      this.taskActivityLog.logCreate(this.taskScope, {
        subjectId: docRef.id,
        subjectTitle: task.title,
      }),
    );
    const next = new Set(this.expandedSubtaskParentIds);
    next.add(parentId);
    this.expandedSubtaskParentIds = next;
  }

  private insertionIndexInRestForMulti(
    length: number,
    selectedIndices: ReadonlySet<number>,
    cur: number,
  ): number {
    const end = Math.max(0, Math.min(cur + 1, length));
    let k = 0;
    for (let i = 0; i < end; i++) {
      if (!selectedIndices.has(i)) {
        k++;
      }
    }
    return k;
  }

  onTaskDrop(event: CdkDragDrop<{ kind: 'root' | 'sub'; task: Task; parentId?: string }[]>): void {
    if (!this.canReorder) {
      return;
    }
    const rows = [...this.visibleListRows()];
    const prev = event.previousIndex;
    const cur = event.currentIndex;
    if (prev < 0 || prev >= rows.length || cur < 0 || cur > rows.length) {
      return;
    }

    const idxSelected = (i: number) => {
      const id = rows[i]?.task.id;
      return !!id && this.selectedTaskIdSet.has(id);
    };

    const selectedIndices = new Set<number>();
    for (let i = 0; i < rows.length; i++) {
      if (idxSelected(i)) {
        selectedIndices.add(i);
      }
    }
    if (!selectedIndices.has(prev)) {
      selectedIndices.clear();
      selectedIndices.add(prev);
    }

    if (selectedIndices.size === 1) {
      if (prev === cur) {
        return;
      }
      const merged = [...rows];
      moveItemInArray(merged, prev, cur);
      if (!this.isValidListRowOrder(merged)) {
        return;
      }
      void this.persistFromVisibleRowOrder(merged);
      return;
    }

    const sortedSel = [...selectedIndices].sort((a, b) => a - b);
    const block = sortedSel.map((i) => rows[i]);
    const rest = rows.filter((_, i) => !selectedIndices.has(i));
    const k = this.insertionIndexInRestForMulti(rows.length, selectedIndices, cur);
    const merged = [...rest.slice(0, k), ...block, ...rest.slice(k)];
    if (!this.isValidListRowOrder(merged)) {
      return;
    }
    void this.persistFromVisibleRowOrder(merged);
  }

  /** リスト表示のフラット行順からルート順・各親の子順を保存 */
  private persistFromVisibleRowOrder(
    merged: { kind: 'root' | 'sub'; task: Task; parentId?: string }[],
  ): void {
    const roots: Task[] = [];
    let i = 0;
    while (i < merged.length) {
      const row = merged[i];
      if (row.kind !== 'root' || !row.task.id) {
        i++;
        continue;
      }
      roots.push(row.task);
      const pid = row.task.id;
      i++;
      const subs: Task[] = [];
      while (
        i < merged.length &&
        merged[i].kind === 'sub' &&
        merged[i].parentId === pid
      ) {
        subs.push(merged[i].task);
        i++;
      }
      if (subs.length > 0) {
        void this.persistSubtaskOrder(pid, subs);
      }
    }
    void this.persistTaskOrder(roots);
  }

  /** カンバン設定ドキュメント参照 */
  private kanbanBoardDocRef(): ReturnType<typeof doc> | null {
    const uid = this.auth.userId();
    if (!uid) {
      return null;
    }
    if (this.taskScope.kind === 'project') {
      return doc(this.firestore, 'projects', this.taskScope.projectId, 'config', 'kanban');
    }
    const scopeKey =
      this.taskScope.privateListId === 'default'
        ? 'private'
        : `pl_${this.taskScope.privateListId}`;
    return doc(this.firestore, 'accounts', uid, 'config', `kanban_${scopeKey}`);
  }

  /** カンバン設定ドキュメントを購読 */
  private async subscribeKanbanBoard(): Promise<void> {
    this.kanbanBoardSub?.unsubscribe();
    this.kanbanBoardSub = undefined;
    const ref = this.kanbanBoardDocRef();
    if (!ref) {
      this.kanbanColumnList = [...DEFAULT_KANBAN_COLUMNS];
      return;
    }
    try {
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, { columns: [...DEFAULT_KANBAN_COLUMNS] }, { merge: true });
      } else {
        const raw = (snap.data() as { columns?: unknown })?.['columns'];
        if (!Array.isArray(raw) || raw.length === 0) {
          await setDoc(ref, { columns: [...DEFAULT_KANBAN_COLUMNS] }, { merge: true });
        }
      }
    } catch (e) {
      console.error('subscribeKanbanBoard seed failed:', e);
    }
    this.kanbanBoardSub = docData(ref).subscribe((data) => {
      const raw = data?.['columns'];
      this.kanbanColumnList = this.normalizeKanbanColumnsFromDoc(raw);
    });
  }

  private normalizeKanbanColumnsFromDoc(raw: unknown): KanbanColumn[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      return [...DEFAULT_KANBAN_COLUMNS];
    }
    const out: KanbanColumn[] = [];
    for (const x of raw) {
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        const id = typeof o['id'] === 'string' ? o['id'].trim() : '';
        const title = typeof o['title'] === 'string' ? o['title'].trim() : '';
        if (id) {
          out.push({ id, title: title || '（無題）' });
        }
      }
    }
    return out.length > 0 ? out : [...DEFAULT_KANBAN_COLUMNS];
  }

  kanbanListId(columnId: string): string {
    return `kanban-${columnId}`;
  }

  /** 列同士をつなぎ、列間ドラッグで移動できるようにする */
  kanbanConnectedIds(): string[] {
    return this.kanbanColumnList.map((c) => this.kanbanListId(c.id));
  }

  private parseKanbanColumnId(containerId: string): string {
    return containerId.startsWith('kanban-') ? containerId.slice('kanban-'.length) : '';
  }

  /** タスクが属するカンバン列 ID（未設定は先頭列） */
  columnIdForTask(task: Task): string {
    const first = this.kanbanColumnList[0]?.id ?? '';
    const k = typeof task.kanbanColumnId === 'string' ? task.kanbanColumnId.trim() : '';
    if (k && this.kanbanColumnList.some((c) => c.id === k)) {
      return k;
    }
    return first;
  }

  tasksForKanbanColumnId(colId: string): Task[] {
    const filtered = this.filterScopeTasks().filter((t) => !t.parentTaskId);
    const inCol = filtered.filter((t) => this.columnIdForTask(t) === colId);
    return [...inCol].sort((a, b) => {
      const c = this.kanbanOrderNum(a) - this.kanbanOrderNum(b);
      if (c !== 0) {
        return c;
      }
      return (a.title ?? '').localeCompare(b.title ?? '');
    });
  }

  /** カンバン同一親の子だけをつなぐドロップリスト ID（列リストとは接続しない） */
  kanbanSubListId(parentId: string): string {
    return `kanban-sub-${parentId}`;
  }

  private buildKanbanColumnState(): Record<string, Task[]> {
    const state: Record<string, Task[]> = {};
    for (const c of this.kanbanColumnList) {
      state[c.id] = this.tasksForKanbanColumnId(c.id);
    }
    return state;
  }

  /** リスト行（task-list-item）のラベル帯色と同じ */
  kanbanLabelColor(task: Task): string {
    const c = task.label?.trim();
    return c || '#e0e0e0';
  }

  /** ドラッグで列間移動（kanbanColumnId のみ更新）。進捗は変えない */
  onKanbanSubtaskDrop(ev: CdkDragDrop<Task>, parentId: string): void {
    const arr = [...this.subtasksForParentKanban(parentId)];
    const prev = ev.previousIndex;
    const cur = ev.currentIndex;
    if (prev < 0 || prev >= arr.length || cur < 0 || cur > arr.length) {
      return;
    }

    const idxSel = (i: number) => {
      const id = arr[i]?.id;
      return !!id && this.selectedTaskIdSet.has(id);
    };

    const selectedIndices = new Set<number>();
    for (let i = 0; i < arr.length; i++) {
      if (idxSel(i)) {
        selectedIndices.add(i);
      }
    }
    if (!selectedIndices.has(prev)) {
      selectedIndices.clear();
      selectedIndices.add(prev);
    }

    if (selectedIndices.size === 1) {
      if (prev === cur) {
        return;
      }
      const single = [...arr];
      moveItemInArray(single, prev, cur);
      void this.persistKanbanSubtaskOrder(parentId, single);
      return;
    }

    const sortedSel = [...selectedIndices].sort((a, b) => a - b);
    const block = sortedSel.map((i) => arr[i]);
    const rest = arr.filter((_, i) => !selectedIndices.has(i));
    const k = this.insertionIndexInRestForMulti(arr.length, selectedIndices, cur);
    const merged = [...rest.slice(0, k), ...block, ...rest.slice(k)];
    void this.persistKanbanSubtaskOrder(parentId, merged);
  }

  onKanbanDrop(ev: CdkDragDrop<Task>): void {
    const task = ev.item.data as Task | undefined;
    if (!task?.id || task.parentTaskId) {
      return;
    }
    const fromId = this.parseKanbanColumnId(ev.previousContainer.id);
    const toId = this.parseKanbanColumnId(ev.container.id);
    if (!fromId || !toId || !this.kanbanColumnList.some((c) => c.id === fromId)) {
      return;
    }
    const state = this.buildKanbanColumnState();
    const prev = ev.previousIndex;
    const cur = ev.currentIndex;

    const isSelRoot = (t: Task | undefined): boolean =>
      !!t?.id && !t.parentTaskId && this.selectedTaskIdSet.has(t.id);

    if (fromId === toId) {
      const arr = [...(state[fromId] ?? [])];
      if (arr.length === 0) {
        return;
      }
      if (prev < 0 || prev >= arr.length || cur < 0 || cur > arr.length) {
        return;
      }

      const selectedIndices = new Set<number>();
      for (let i = 0; i < arr.length; i++) {
        if (isSelRoot(arr[i])) {
          selectedIndices.add(i);
        }
      }
      if (!selectedIndices.has(prev)) {
        selectedIndices.clear();
        selectedIndices.add(prev);
      }

      if (selectedIndices.size === 1) {
        if (prev === cur) {
          return;
        }
        const single = [...arr];
        moveItemInArray(single, prev, cur);
        state[fromId] = single;
        void this.persistKanbanBoardOrder(state);
        return;
      }

      const sortedSel = [...selectedIndices].sort((a, b) => a - b);
      const block = sortedSel.map((i) => arr[i]);
      const rest = arr.filter((_, i) => !selectedIndices.has(i));
      const k = this.insertionIndexInRestForMulti(arr.length, selectedIndices, cur);
      state[fromId] = [...rest.slice(0, k), ...block, ...rest.slice(k)];
      void this.persistKanbanBoardOrder(state);
      return;
    }

    if (!this.kanbanColumnList.some((c) => c.id === toId)) {
      return;
    }
    const fromArr = [...(state[fromId] ?? [])];
    const toArr = [...(state[toId] ?? [])];
    if (prev < 0 || prev >= fromArr.length || cur < 0 || cur > toArr.length) {
      return;
    }

    const selectedIndices = new Set<number>();
    for (let i = 0; i < fromArr.length; i++) {
      if (isSelRoot(fromArr[i])) {
        selectedIndices.add(i);
      }
    }
    if (!selectedIndices.has(prev)) {
      selectedIndices.clear();
      selectedIndices.add(prev);
    }

    if (selectedIndices.size === 1) {
      const fa = [...fromArr];
      const ta = [...toArr];
      const [moved] = fa.splice(prev, 1);
      if (!moved) {
        return;
      }
      const updated: Task = { ...moved, kanbanColumnId: toId };
      ta.splice(Math.min(cur, ta.length), 0, updated);
      state[fromId] = fa;
      state[toId] = ta;
      void this.persistKanbanBoardOrder(state);
      return;
    }

    const sortedSel = [...selectedIndices].sort((a, b) => a - b);
    const block = sortedSel
      .map((i) => fromArr[i])
      .map((t) => ({ ...t, kanbanColumnId: toId }));
    const fromRemainder = fromArr.filter((_, i) => !selectedIndices.has(i));
    const insertAt = Math.min(Math.max(0, cur), toArr.length);
    state[fromId] = fromRemainder;
    state[toId] = [...toArr.slice(0, insertAt), ...block, ...toArr.slice(insertAt)];
    void this.persistKanbanBoardOrder(state);
  }

  private async persistKanbanBoardOrder(state: Record<string, Task[]>): Promise<void> {
    const flat: Task[] = [];
    for (const col of this.kanbanColumnList) {
      flat.push(...(state[col.id] ?? []));
    }
    const batch = writeBatch(this.firestore);
    const firstCol = this.kanbanColumnList[0]?.id ?? null;
    flat.forEach((t, i) => {
      const id = t.id;
      if (!id) {
        return;
      }
      const r = this.taskDocRef(id);
      if (!r) {
        return;
      }
      const kid = t.kanbanColumnId ?? firstCol;
      batch.update(r, { kanbanOrderIndex: i * 1000, kanbanColumnId: kid });
      for (const ch of this.tasks) {
        if (ch.parentTaskId === id && ch.id) {
          const r2 = this.taskDocRef(ch.id);
          if (r2) {
            batch.update(r2, { kanbanColumnId: kid });
          }
        }
      }
    });
    try {
      await batch.commit();
    } catch (e) {
      console.error('persistKanbanBoardOrder failed:', e);
    }
  }

  async renameKanbanColumn(col: KanbanColumn): Promise<void> {
    const n = window.prompt('リスト名', col.title);
    if (n === null) {
      return;
    }
    const title = n.trim() || '（無題）';
    const ref = this.kanbanBoardDocRef();
    if (!ref) {
      return;
    }
    const next = this.kanbanColumnList.map((c) =>
      c.id === col.id ? { ...c, title } : c,
    );
    try {
      await setDoc(ref, { columns: next }, { merge: true });
      await this.taskActivityLog.logKanbanUpdate(this.taskScope, {
        subjectId: col.id,
        subjectTitle: title,
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : '更新に失敗しました');
    }
  }

  async deleteKanbanColumn(col: KanbanColumn): Promise<void> {
    if (this.kanbanColumnList.length <= 1) {
      alert('最後の1列は削除できません。');
      return;
    }
    if (
      !confirm(
        `「${col.title}」を削除しますか？\nこの列のタスクは他の列へ移動します。`,
      )
    ) {
      return;
    }
    const ref = this.kanbanBoardDocRef();
    if (!ref) {
      return;
    }
    const idx = this.kanbanColumnList.findIndex((c) => c.id === col.id);
    if (idx < 0) {
      return;
    }
    const fallbackId =
      idx === 0 ? this.kanbanColumnList[1].id : this.kanbanColumnList[0].id;
    const nextCols = this.kanbanColumnList.filter((c) => c.id !== col.id);
    const affected = this.tasks.filter((t) => {
      const cid = this.columnIdForTask(t);
      return cid === col.id;
    });
    try {
      await this.taskActivityLog.logKanbanDelete(this.taskScope, {
        subjectId: col.id,
        subjectTitle: col.title,
      });
      const batch = writeBatch(this.firestore);
      for (const t of affected) {
        const tid = t.id;
        if (!tid) {
          continue;
        }
        const r = this.taskDocRef(tid);
        if (r) {
          batch.update(r, { kanbanColumnId: fallbackId });
        }
      }
      await batch.commit();
      await setDoc(ref, { columns: nextCols }, { merge: true });
    } catch (e) {
      alert(e instanceof Error ? e.message : '削除に失敗しました');
    }
  }

  async addKanbanColumn(): Promise<void> {
    const ref = this.kanbanBoardDocRef();
    if (!ref) {
      return;
    }
    const id = `kb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    const title = `リスト ${this.kanbanColumnList.length + 1}`;
    const next = [...this.kanbanColumnList, { id, title }];
    try {
      await setDoc(ref, { columns: next }, { merge: true });
      await this.taskActivityLog.logKanbanCreate(this.taskScope, {
        subjectId: id,
        subjectTitle: title,
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : '追加に失敗しました');
    }
  }

  onKanbanSubtasksToggleClick(ev: MouseEvent, task: Task): void {
    ev.preventDefault();
    ev.stopPropagation();
    const id = task.id;
    if (!id) {
      return;
    }
    if (this.hasChildTasks(id)) {
      this.toggleSubtasksExpanded(id);
    } else {
      this.openSubtaskDialog(task);
    }
  }

  onKanbanCardClick(ev: MouseEvent, task: Task): void {
    const el = ev.target as HTMLElement | null;
    if (!el || el.closest('button') || el.closest('.kanban-label-strip')) {
      return;
    }
    ev.preventDefault();
    const id = task.id;
    if (!id) {
      return;
    }
    const prev = task.status;
    const next = nextTaskStatus(prev);
    const ref = this.taskDocRef(id);
    if (!ref) {
      return;
    }
    void updateDoc(ref, taskStatusTransitionPatch(next, prev))
      .then(() =>
        this.taskActivityLog.logUpdate(this.taskScope, {
          subjectId: id,
          subjectTitle: task.title,
        }),
      )
      .catch((err) => console.error('kanban status update failed:', err));
  }

  openKanbanDetail(ev: Event, task: Task): void {
    ev.preventDefault();
    ev.stopPropagation();
    const id = task.id;
    if (!id) {
      return;
    }
    saveTaskShellScrollPosition();
    void this.router.navigate(['/task', taskDetailScopeParam(this.taskScope), id], {
      queryParams: { from: 'kanban' },
    });
  }

  private tasksCollectionRef(userId: string) {
    if (this.taskScope.kind === 'project') {
      return collection(this.firestore, 'projects', this.taskScope.projectId, 'tasks');
    }
    const pid = this.taskScope.privateListId;
    return pid === 'default'
      ? collection(this.firestore, 'accounts', userId, 'tasks')
      : collection(
          this.firestore,
          'accounts',
          userId,
          'privateTaskLists',
          pid,
          'tasks',
        );
  }

  private taskDocRef(taskId: string) {
    const userId = this.auth.userId();
    if (!userId) {
      return null;
    }
    if (this.taskScope.kind === 'project') {
      return doc(this.firestore, 'projects', this.taskScope.projectId, 'tasks', taskId);
    }
    const pid = this.taskScope.privateListId;
    return pid === 'default'
      ? doc(this.firestore, 'accounts', userId, 'tasks', taskId)
      : doc(
          this.firestore,
          'accounts',
          userId,
          'privateTaskLists',
          pid,
          'tasks',
          taskId,
        );
  }

  openReportPage(): void {
    void this.router.navigate(['/report', taskDetailScopeParam(this.taskScope)]);
  }

  openAddTaskDialog(): void {
    const ref = this.dialog.open(TaskFormDialog, {
      width: 'min(96vw, 560px)',
      autoFocus: 'first-tabbable',
      data: {
        taskScope: this.taskScope,
        projectMembers: this.projectMembers,
      },
    });
    ref.afterClosed().subscribe((task: Task | undefined) => {
      if (task) {
        this.addTask(task);
      }
    });
  }

  openSubtaskDialog(parent: Task): void {
    const ref = this.dialog.open(TaskFormDialog, {
      width: 'min(96vw, 560px)',
      autoFocus: 'first-tabbable',
      data: {
        taskScope: this.taskScope,
        projectMembers: this.projectMembers,
        dialogMode: 'subtask' as const,
        parentTask: parent,
      },
    });
    ref.afterClosed().subscribe((task: Task | undefined) => {
      if (task) {
        this.addSubtask(parent, task);
      }
    });
  }

  openTaskContextMenu(ev: MouseEvent, task: Task): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.openTaskContextMenuAt(ev.clientX, ev.clientY, task);
  }

  openTaskContextMenuAt(clientX: number, clientY: number, task: Task): void {
    this.ctxTask = task;
    const tid = task.id;
    if (tid && this.selectedTaskIdSet.size >= 2 && this.selectedTaskIdSet.has(tid)) {
      this.ctxBulkMode = true;
      this.ctxBulkIds = [...this.selectedTaskIdSet];
    } else {
      this.ctxBulkMode = false;
      this.ctxBulkIds = [];
    }
    this.contextMenuX = clientX;
    this.contextMenuY = clientY;
    queueMicrotask(() => this.taskCtxMenuTrigger?.openMenu());
  }

  ctxBulkEditNavigate(): void {
    const ids = this.ctxBulkIds;
    if (ids.length < 2) {
      return;
    }
    saveTaskShellScrollPosition();
    void this.router.navigate(
      ['/tasks', 'bulk-edit', taskDetailScopeParam(this.taskScope)],
      {
        queryParams: { ids: ids.join(','), from: 'list' },
      },
    );
  }

  ctxBulkDeleteFromMenu(): void {
    const ids = this.ctxBulkIds;
    if (ids.length < 2) {
      return;
    }
    if (!confirm(`${ids.length}件のタスクを削除しますか？\n選択されていない子タスクも削除されます。`)) {
      return;
    }
    void this.bulkDeleteTaskIds(ids).then(() => this.clearTaskSelection());
  }

  ctxDuplicateTasks(): void {
    const tasks: Task[] = [];
    if (this.ctxBulkMode && this.ctxBulkIds.length >= 2) {
      const byId = new Map(this.tasks.map((t) => [t.id, t]));
      for (const id of this.ctxBulkIds) {
        const t = byId.get(id);
        if (t) {
          tasks.push(t);
        }
      }
    } else if (this.ctxTask?.id) {
      tasks.push(this.ctxTask);
    }
    if (tasks.length === 0) {
      return;
    }
    this.dialog.open(TaskDuplicateDialog, {
      width: 'min(520px, 92vw)',
      autoFocus: 'first-tabbable',
      data: {
        tasks,
        taskScope: this.taskScope,
      },
    });
  }

  /** 各 ID について子ツリーを含めて削除（重複はまとめる） */
  private async bulkDeleteTaskIds(rootIds: string[]): Promise<void> {
    const all = new Set<string>();
    for (const id of rootIds) {
      for (const x of this.collectSubtreeIds(id)) {
        all.add(x);
      }
    }
    const byId = new Map(this.tasks.map((t) => [t.id, t]));
    const batch = writeBatch(this.firestore);
    for (const id of all) {
      const t = byId.get(id);
      if (!t) {
        continue;
      }
      const title = t.title.trim() || '（無題）';
      void this.taskActivityLog.logDelete(this.taskScope, {
        subjectId: id,
        subjectTitle: title,
      });
      const r = this.taskDocRef(id);
      if (r) {
        batch.delete(r);
      } 
    }
    try {
      await batch.commit();
    } catch (e) {
      console.error('bulkDeleteTaskIds failed:', e);
    }
  }

  private collectSubtreeIds(rootId: string): Set<string> {
    const out = new Set<string>();
    const walk = (pid: string) => {
      out.add(pid);
      for (const x of this.tasks) {
        if (x.parentTaskId === pid && x.id) {
          walk(x.id);
        }
      }
    };
    walk(rootId);
    return out;
  }

  ctxNavigateDetail(): void {
    const t = this.ctxTask;
    if (!t?.id) {
      return;
    }
    const from =
      this.viewMode === 'kanban'
        ? 'kanban'
        : this.viewMode === 'calendar'
          ? 'calendar'
          : 'list';
    saveTaskShellScrollPosition();
    void this.router.navigate(['/task', taskDetailScopeParam(this.taskScope), t.id], {
      queryParams: {
        from,
        ...(this.viewMode === 'calendar' ? { cal: this.calendarGranularity } : {}),
      },
    });
  }

  ctxOpenCreateSubtaskDialog(): void {
    const t = this.ctxTask;
    if (!t?.id || t.parentTaskId) {
      return;
    }
    this.openSubtaskDialog(t);
  }

  /**右クリックで削除を実行 */
  async ctxDeleteTask(): Promise<void> {
    const t = this.ctxTask;
    if (!t?.id) {
      return;
    }
    const id = t.id;
    if (!confirm('このタスクを削除しますか？')) {
      return;
    }
    try {await this.taskActivityLog.logDelete(this.taskScope, {
          subjectId: id,
          subjectTitle: t.title || '（無題）',
        });
        await this.deleteTaskCascade(t.id);
      } catch(err) {
        console.error('task delete failed:', err)}
  }

  /**詳細フォームから削除を実行 */
  async onDeleteTaskFromItem(task: Task): Promise<void> {
    const id = task.id;
    if (!id) {
      return;
    }
    if (!confirm('このタスクを削除しますか？')) {
      return;
    }
    try {await this.taskActivityLog.logDelete(this.taskScope, {
          subjectId: id,
          subjectTitle: task.title || '（無題）',
        });
        await this.deleteTaskCascade(id);
    } catch(err) {
      console.error('task delete failed:', err)}
  }

  /**子タスクを再帰的に削除 */
  private async deleteTaskCascade(rootId: string): Promise<void> {
    const toDelete = new Set<string>([rootId]);
    const walk = (pid: string) => {
      for (const x of this.tasks) {
        if (x.parentTaskId === pid && x.id) {
          toDelete.add(x.id);
          void this.taskActivityLog.logDelete(this.taskScope, {
            subjectId: x.id,
            subjectTitle: x.title || '（無題）',
          }).catch((err) => console.error('task delete failed:', err));
          walk(x.id);
        }
      }
    };
    walk(rootId);
    const batch = writeBatch(this.firestore);
    for (const id of toDelete) {
      const r = this.taskDocRef(id);
      if (r) {
        batch.delete(r);
      }
    }
    try {
      await batch.commit();
    } catch (e) {
      console.error('deleteTaskCascade failed:', e);
    }
  }

  private async persistTaskOrder(ordered: Task[]): Promise<void> {
    const batch = writeBatch(this.firestore);
    ordered.forEach((task, index) => {
      const id = task.id;
      if (!id) {
        return;
      }
      const r = this.taskDocRef(id);
      if (!r) {
        return;
      }
      const v = index * 1000;
      batch.update(r, { listOrderIndex: v });
    });
    try {
      await batch.commit();
    } catch (e) {
      console.error('persistTaskOrder failed:', e);
    }
  }

  private async persistSubtaskOrder(parentId: string, ordered: Task[]): Promise<void> {
    const batch = writeBatch(this.firestore);
    ordered.forEach((task, index) => {
      const id = task.id;
      if (!id) {
        return;
      }
      if (task.parentTaskId !== parentId) {
        return;
      }
      const r = this.taskDocRef(id);
      if (!r) {
        return;
      }
      const v = index * 1000;
      batch.update(r, { listOrderIndex: v });
    });
    try {
      await batch.commit();
    } catch (e) {
      console.error('persistSubtaskOrder failed:', e);
    }
  }

  private async persistKanbanSubtaskOrder(parentId: string, ordered: Task[]): Promise<void> {
    const batch = writeBatch(this.firestore);
    ordered.forEach((task, index) => {
      const id = task.id;
      if (!id) {
        return;
      }
      if (task.parentTaskId !== parentId) {
        return;
      }
      const r = this.taskDocRef(id);
      if (!r) {
        return;
      }
      batch.update(r, { kanbanOrderIndex: index * 1000 });
    });
    try {
      await batch.commit();
    } catch (e) {
      console.error('persistKanbanSubtaskOrder failed:', e);
    }
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
    this.membersSub?.unsubscribe();
    this.kanbanBoardSub?.unsubscribe();
  }
}
