import { Component, inject, Input, OnChanges, OnDestroy, OnInit, SimpleChanges, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Task } from '../../models/task';
import { firestoreStatusFields } from '../../models/task-status';
import { TaskSortField } from '../task-sort';
import { colorFilterOptions, DueDateFilter, isFilterDefaultForReorder } from '../task-filter';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatRadioModule } from '@angular/material/radio';
import { MatDividerModule } from '@angular/material/divider';
import { MatDialogModule } from '@angular/material/dialog';
import { Firestore, collection, addDoc, doc, Timestamp, serverTimestamp, collectionData, writeBatch, updateDoc, getDoc, setDoc, docData, increment } from '@angular/fire/firestore';
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
import {
  DEFAULT_KANBAN_COLUMNS,
  type KanbanColumn,
} from '../../models/kanban-column';
import { TASK_STATUS_OPTIONS } from '../../models/task-status';
import { TaskActivityLogService } from '../task-activity-log.service';
import { TaskCollectionReferenceService } from '../task-collection-reference.service';
import { TaskListDataService } from './task-list-data.service';
import { TaskListContextActionsService } from './task-list-context-actions.service';
import { TaskListTaskCtxMenu } from './task-list-ctx-menu';
import { TaskListKanbanView } from './task-list-kanban-view';
import { TaskListListView } from './task-list-list-view';

@Component({
  selector: 'app-task-list',
  imports: [
    CommonModule,
    FormsModule,
    TaskCalendar,
    TaskListTaskCtxMenu,
    TaskListKanbanView,
    TaskListListView,
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
    MatDividerModule,
    UserAvatar,
  ],
  templateUrl: './task-list.html',
  styleUrl: './task-list.css',
  providers: [TaskListDataService, TaskListContextActionsService],
})
export class TaskList implements OnInit, OnDestroy, OnChanges {
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly projectSession = inject(ProjectSessionService);
  private readonly taskActivityLog = inject(TaskActivityLogService);
  private readonly taskCollectionRef = inject(TaskCollectionReferenceService);
  readonly DataService = inject(TaskListDataService);
  readonly ContextActions = inject(TaskListContextActionsService);
  private subscriptions = new Subscription();

  @Input() taskScope: TaskScope = { kind: 'private', privateListId: 'default' };

  /** リスト表示 / カレンダー / カンバン */
  viewMode: 'list' | 'calendar' | 'kanban' = 'list';
  /** カレンダー時の月／週／日 */
  calendarGranularity: TaskCalendarGranularity = 'month';
  /** カレンダーの基準日（月の表示月・週の週・日のその日） */
  calendarViewDate = new Date();
  /** 月・週表示の週の左端（日曜 / 月曜） */
  calendarWeekdayStart: TaskCalendarWeekdayStart = 'Sunday';

  /** プロジェクトのメンバー（担当者選択・フィルタ用） */
  projectMembers: ProjectMemberRow[] = [];

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

  /** Firestore と同期するカンバン列 */
  kanbanColumnList: KanbanColumn[] = [...DEFAULT_KANBAN_COLUMNS];

  @ViewChild('taskCtxMenuTrigger') taskCtxMenuTrigger?: MatMenuTrigger;
  @ViewChild('dayCtxMenuTrigger') dayCtxMenuTrigger?: MatMenuTrigger;
  @ViewChild(TaskListTaskCtxMenu) taskCtxMenu?: TaskListTaskCtxMenu;
  @ViewChild(TaskListKanbanView) kanbanView?: TaskListKanbanView;

  contextMenuX = 0;
  contextMenuY = 0;
  ctxTask: Task | null = null;
  ctxDate: Date | null = null;
  ctxBulkMode = false;
  ctxBulkIds: string[] = [];

  get tasks(): Task[] {
    return this.DataService.tasks();
  }

  get displayRootTasks(): Task[] {
    return this.DataService.displayRootTasks();
  }

  /** 並べ替えヒント用（`TaskListListView` の `canReorder` と条件を揃える） */
  get canReorder(): boolean {
    if (this.viewMode !== 'list') {
      return false;
    }
    const sk = this.DataService.sortKeys();
    return (
      isFilterDefaultForReorder(
        this.DataService.filterState(),
        this.taskScope.kind === 'project',
      ) &&
      sk.f1 === null &&
      sk.f2 === null &&
      sk.f3 === null
    );
  }

  /** フィルタのスウォッチ用。チャート外の #RRGGBB もその色で表示 */
  labelCssForFilter(hex: string): string {
    const t = hex?.trim() ?? '';
    if (/^#[0-9A-Fa-f]{6}$/.test(t)) {
      return t;
    }
    return '#bdbdbd';
  }

  resetFilters(): void {
    this.DataService.resetFilters();
  }

  get isProjectScope(): boolean {
    return this.taskScope.kind === 'project';
  }

  /** 担当者フィルタの選択行（トリガー表示用） */
  filterSelectedMember(): ProjectMemberRow | null {
    const id = this.DataService.filterState().assignee;
    if (id === 'all' || id === 'unassigned') {
      return null;
    }
    return this.projectMembers.find((m) => m.userId === id) ?? null;
  }

  /** 色フィルタの候補（チャート＋タスクに含まれるその他の色） */
  get colorOptionsForFilter(): string[] {
    return colorFilterOptions(this.DataService.tasks());
  }

  onSubtasksToggleForListItem(task: Task): void {
    const id = task.id;
    if (!id) {
      return;
    }
    if (this.DataService.hasChildTasks(id)) {
      this.DataService.toggleSubtasksExpanded(id);
    } else {
      this.openSubtaskDialog(task);
    }
  }

  private startSubtaskSubscription(parentId: string): void {
    const userId = this.auth.userId();
    if (!userId) return;
    const baseRef = this.taskCollectionRef.tasksCollectionRef(userId, this.taskScope);
    if (!baseRef) return;

    this.DataService.subscribeSubtasks(parentId, baseRef);
  }

  trackByTaskId(_index: number, task: Task): string {
    return task.id ?? `idx-${_index}`;
  }

  private restartSubscriptions(): void {
    this.subscriptions.unsubscribe();
    this.subscriptions = new Subscription();
    this.subscribeTasks();
    this.subscribeProjectMembers();
    void this.subscribeKanbanBoard();
  }

  ngOnInit() {
    /** 表示は常にタブ（taskScope）別 localStorage のみ。URL はグローバルなので初期表示に使わない。 */
    this.loadViewPrefsFromStorage();
    this.onTaskListViewUiChange();
    this.DataService.setProjectScope(this.isProjectScope);
    this.restartSubscriptions();
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
    return this.DataService.isTaskSelected(taskId);
  }

  /** リスト／カンバン一括選択用 */
  selectableTaskIdsForBulk(): string[] {
    if (this.viewMode === 'kanban') {
      return this.DataService.kanbanBulkSelectableTaskIds(this.kanbanColumnList);
    }
    if (this.viewMode === 'list') {
      return this.DataService.listBulkSelectableTaskIds();
    }
    return [];
  }

  isAllVisibleSelected(): boolean {
    const visible = this.selectableTaskIdsForBulk();
    if (visible.length === 0) {
      return false;
    }
    return visible.every((id) => this.DataService.isTaskSelected(id));
  }

  isSomeVisibleSelected(): boolean {
    const visible = this.selectableTaskIdsForBulk();
    return visible.some((id) => this.DataService.isTaskSelected(id));
  }

  onBulkSelectCheckboxChange(ev: MatCheckboxChange): void {
    this.DataService.selectAllTasks(ev.checked, this.selectableTaskIdsForBulk());
  }

  /** ユーザーがリスト/カレンダー/カンバンを切り替えたとき URL と localStorage を同期 */
  onTaskListViewUiChange(): void {
    if (this.viewMode !== 'list') {
      this.DataService.clearTaskSelection();
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
        this.DataService.setProjectScope(this.isProjectScope);
        this.restartSubscriptions();
        if (!this.isProjectScope) {
          this.DataService.patchFilter({ assignee: 'all' });
        }
      }
    }
  }

  private subscribeProjectMembers(): void {
    if (this.taskScope.kind !== 'project') {
      this.projectMembers = [];
      return;
    }
    const pid = this.taskScope.projectId;
    const ref = collection(this.firestore, 'projects', pid, 'members');

    const membersSub = collectionData(ref, { idField: 'id' })
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
      .subscribe({
        next: (members) => {
        this.projectMembers = members.filter((m) => m.userId);
        },
        error: (error) => {
          console.error('subscribeProjectMembers error:', error);
        },
      });

    this.subscriptions.add(membersSub);
  }

  private subscribeTasks() {
    const userId = this.auth.userId();
    if (!userId) return;
    const baseRef = this.taskCollectionRef.tasksCollectionRef(userId, this.taskScope);
    if (!baseRef) return;

    this.DataService.initForScope(baseRef);
  }

  addTask(task: Task) {
    const userId = this.auth.userId();
    if (!userId) return;
    const col = this.taskCollectionRef.tasksCollectionRef(userId, this.taskScope);
    if (!col) return;
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
    const roots = this.DataService.tasks().filter((t) => !t.parentTaskId);
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
    payload['parentTaskId'] = null;
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
    if (!userId || !parentId) return;
    const col = this.taskCollectionRef.tasksCollectionRef(userId, this.taskScope);
    if (!col) return;
    const batch = writeBatch(this.firestore);
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
    const pCol = this.kanbanView?.columnIdForTask(parent) ?? '';
    payload['kanbanColumnId'] = pCol;
    const siblings = this.DataService.tasks().filter((t) => t.parentTaskId === parentId);
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
    const subtaskRef = doc(col);
    batch.set(subtaskRef, payload);
    const parentRef = doc(col, parentId);
    batch.update(parentRef, { 
      childTaskCount: increment(1)
    });
    try {
      void batch.commit();
      this.taskActivityLog.logCreate(this.taskScope, {
        subjectId: subtaskRef.id,
        subjectTitle: task.title,
      });
    } catch (e) {
      console.error('addSubtask failed:', e);
    }
    if (this.DataService.expandedTaskIds().has(parentId)) {
      return;
    }
    const next = new Set(this.DataService.expandedTaskIds());
    next.add(parentId);
    this.DataService.expandedTaskIds.set(next);
    this.startSubtaskSubscription(parentId);
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
    const kanbanBoardSub = docData(ref).subscribe({
      next: (data) => {
      const raw = data?.['columns'];
      this.kanbanColumnList = this.normalizeKanbanColumnsFromDoc(raw);
    },
    error: (error) => {
      console.error('subscribeKanbanBoard error:', error);
    },
    });

    this.subscriptions.add(kanbanBoardSub);
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

  taskDocRef(taskId: string) {
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
    const date = this.ctxDate;
    this.ctxDate = null;
    this.ContextActions.openAddTask(this.taskScope, this.projectMembers, date, (task: Task) => this.addTask(task));
  }

  openSubtaskDialog(parent: Task): void {
    const date = this.ctxDate;
    this.ctxDate = null;
    this.ContextActions.openAddSubtask(this.taskScope, this.projectMembers, parent, date, (task: Task) => this.addSubtask(parent, task));
  }

  /** コンテキストメニュー用の親側状態（子はアンカー位置のみ保持。ハンドラはここを参照する） */
  private syncCtxMenuStateForTask(task: Task): void {
    const tid = task.id;
    if (
      tid &&
      this.DataService.selectedTaskIdSet().size >= 2 &&
      this.DataService.isTaskSelected(tid)
    ) {
      this.ctxBulkMode = true;
      this.ctxBulkIds = [...this.DataService.selectedTaskIdSet()];
    } else {
      this.ctxBulkMode = false;
      this.ctxBulkIds = [];
    }
    this.ctxTask = task;
  }

  openTaskContextMenu(ev: MouseEvent, task: Task): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.syncCtxMenuStateForTask(task);
    this.taskCtxMenu?.open(ev.clientX, ev.clientY, task);
  }

  onCalendarTaskContextMenu(payload: {
    clientX: number;
    clientY: number;
    task: Task;
  }): void {
    this.syncCtxMenuStateForTask(payload.task);
    this.taskCtxMenu?.open(payload.clientX, payload.clientY, payload.task);
  }

  /** カンバン子の Output 用（テンプレの $event を MouseEvent + Task に絞る） */
  onKanbanTaskContextMenu(payload: { ev: MouseEvent; task: Task }): void {
    this.openTaskContextMenu(payload.ev, payload.task);
  }

  openDayContextMenuAt(clientX: number, clientY: number, date: Date): void {
    this.ctxDate = date;
    this.contextMenuX = clientX;
    this.contextMenuY = clientY;
    queueMicrotask(() => this.dayCtxMenuTrigger?.openMenu());
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
    void this.bulkDeleteTaskIds(ids).then(() => this.DataService.clearTaskSelection());
  }

  ctxDuplicateTasks(): void {
    this.ContextActions.openDuplicateDialog(this.ctxBulkMode, this.ctxBulkIds, this.ctxTask, this.taskScope);
  }

  /** 各 ID について子ツリーを含めて削除（重複はまとめる） */
  private async bulkDeleteTaskIds(rootIds: string[]): Promise<void> {
    const all = new Set<string>();
    for (const id of rootIds) {
      for (const x of this.collectSubtreeIds(id)) {
        all.add(x);
      }
    }
    const byId = new Map(this.DataService.tasks().map((t) => [t.id, t]));
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
      for (const x of this.DataService.tasks()) {
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
    this.ContextActions.navigateToDetail(t, this.taskScope, from);
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
        await this.deleteTask(t.id);
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
        await this.deleteTask(id);
    } catch(err) {
      console.error('task delete failed:', err)}
  }

  /**タスクの削除 
   * 直下の子は Firestore onDelete トリガ（functions）で連鎖削除。
   * 子タスクを削除する場合は親の childTaskCount を 1 減らす。
  */
   private async deleteTask(rootId: string): Promise<void> {
    const r = this.taskDocRef(rootId);
    if (!r) {
      return;
    }
    let parentTaskId: string | null = null;
    try {
      const snap = await getDoc(r);
      if (!snap.exists()) {
        return;
      }
      const p = snap.data()['parentTaskId'];
      parentTaskId =
        typeof p === 'string' && p.trim() !== '' ? p.trim() : null;
    } catch (e) {
      console.error('deleteTask: read parentTaskId failed:', e);
      return;
    }
    const batch = writeBatch(this.firestore);
    batch.delete(r);
    if (parentTaskId) {
      const pr = this.taskDocRef(parentTaskId);
      if (pr) {
        batch.update(pr, {
          childTaskCount: increment(-1)
        });
      }
    }
    try {
      await batch.commit();
    } catch (e) {
      console.error('deleteTask failed:', e);
    }
  }

  ngOnDestroy() {
    this.subscriptions.unsubscribe();
    this.DataService.destroy();
  }
}
