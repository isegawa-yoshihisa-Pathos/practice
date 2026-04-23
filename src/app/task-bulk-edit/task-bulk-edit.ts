import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  writeBatch,
  Timestamp,
  deleteField,
  collectionData,
} from '@angular/fire/firestore';
import { combineLatest } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatRadioModule } from '@angular/material/radio';
import { MatDatepickerModule } from '@angular/material/datepicker';
import { MatIconModule } from '@angular/material/icon';
import { map } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import { AuthService } from '../auth.service';
import { DEFAULT_TASK_LABEL_COLOR, TASK_COLOR_CHART } from '../task-colors';
import {
  clampTaskPriority,
  DEFAULT_TASK_PRIORITY,
  TASK_PRIORITY_OPTIONS,
} from '../task-priority';
import { TASK_RETURN_QUERY } from '../task-return-query';
import { ProjectSessionService, type TaskListViewPrefs } from '../project-session.service';
import { taskListViewStorageKeyFromDetailParam, taskScopeFromDetailRouteParam } from '../task-scope';
import {
  normalizeTaskStatusFromDoc,
  TASK_STATUS_OPTIONS,
  type TaskStatus,
} from '../../models/task-status';
import type { Task } from '../../models/task';
import type { ProjectMemberRow } from '../../models/project-member';
import { UserAvatar } from '../user-avatar/user-avatar';
import { TaskActivityLogService } from '../task-activity-log.service';
import { taskStatusTransitionPatch } from '../task-firestore-mutation';
import { TaskCollectionReferenceService } from '../task-collection-reference.service';
import {
  TASK_HOUR_OPTIONS,
  TASK_MINUTE_OPTIONS,
  composeLocalDateTime,
  localHourAndMinute,
  startOfLocalDate,
  taskScheduleMode,
  timestampLikeToDate,
} from '../task-schedule';

/**
 * カスケード削除の 1 件。`getDocs` で取得したドキュメントからタイトルを解決するため
 * フル {@link Task} より `{ id, title }` の方がログ用途に十分で軽い。
 */
type DeleteCascadeEntry = { id: string; title: string };

@Component({
  selector: 'app-task-bulk-edit',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatRadioModule,
    MatDatepickerModule,
    MatIconModule,
    UserAvatar,
  ],
  templateUrl: './task-bulk-edit.html',
  styleUrl: './task-bulk-edit.css',
})
export class TaskBulkEdit implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly projectSession = inject(ProjectSessionService);
  private readonly taskActivityLog = inject(TaskActivityLogService);
  private readonly taskCollectionRef = inject(TaskCollectionReferenceService);
  readonly assigneeNone = '';
  readonly colorChart = TASK_COLOR_CHART;
  readonly priorityOptions = TASK_PRIORITY_OPTIONS;
  readonly statusOptions = TASK_STATUS_OPTIONS;

  loading = true;
  notFound = false;
  saveError: string | null = null;

  scopeParam = '';
  taskIds: string[] = [];
  loadedTasks: Task[] = [];

  titlesDisplay = '';

  projectMembers: ProjectMemberRow[] = [];
  private membersSub?: Subscription;

  editAssignee = '';
  editLabel: string = DEFAULT_TASK_LABEL_COLOR;
  editPriority = DEFAULT_TASK_PRIORITY;
  editStatus: TaskStatus = 'todo';

  scheduleBulkMode: 'unchanged' | 'absolute' | 'relative' = 'unchanged';
  scheduleEditMode: 'none' | 'deadline' | 'window' = 'none';
  deadlineDate: Date | null = null;
  deadlineHour = 9;
  deadlineMinute = 0;
  startDate: Date | null = null;
  startHour = 9;
  startMinute = 0;
  endDate: Date | null = null;
  endHour = 9;
  endMinute = 0;
  readonly hourOptions = TASK_HOUR_OPTIONS;
  readonly minuteOptions = TASK_MINUTE_OPTIONS;

  relDays = 0;
  relHours = 0;
  relMinutes = 0;

  ngOnInit(): void {
    combineLatest([this.route.paramMap, this.route.queryParamMap])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(([params, q]) => {
        this.scopeParam = params.get('scope') ?? '';
        const raw = q.get('ids') ?? '';
        this.taskIds = raw
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        this.subscribeProjectMembers();
        void this.loadTasks();
      });
  }

  private subscribeProjectMembers(): void {
    this.membersSub?.unsubscribe();
    this.membersSub = undefined;
    this.projectMembers = [];
    if (this.scopeParam === 'private' || this.scopeParam.startsWith('pl-') || !this.scopeParam) {
      return;
    }
    const refCol = collection(this.firestore, 'projects', this.scopeParam, 'members');
    this.membersSub = collectionData(refCol, { idField: 'id' })
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

  assigneeSelectedMember(): ProjectMemberRow | null {
    const id = this.editAssignee?.trim();
    if (!id) {
      return null;
    }
    return this.projectMembers.find((m) => m.userId === id) ?? null;
  }

  private taskDocRef(taskId: string) {
    const userId = this.auth.userId();
    if (!userId || !taskId) {
      return null;
    }
    if (this.scopeParam === 'private') {
      return doc(this.firestore, 'accounts', userId, 'tasks', taskId);
    }
    if (this.scopeParam.startsWith('pl-')) {
      const listId = this.scopeParam.slice(3);
      return doc(
        this.firestore,
        'accounts',
        userId,
        'privateTaskLists',
        listId,
        'tasks',
        taskId,
      );
    }
    return doc(this.firestore, 'projects', this.scopeParam, 'tasks', taskId);
  }

  private mapDocToTask(id: string, data: Record<string, unknown>): Task {
    const deadline = timestampLikeToDate(data['deadline']);
    const startAt = timestampLikeToDate(data['startAt']);
    const endAt = timestampLikeToDate(data['endAt']);
    return {
      ...data,
      id,
      title: typeof data['title'] === 'string' ? data['title'] : '',
      label:
        typeof data['label'] === 'string' && data['label'].trim() !== ''
          ? data['label']
          : '',
      status: normalizeTaskStatusFromDoc(data),
      priority: clampTaskPriority(data['priority']),
      deadline,
      startAt,
      endAt,
    } as Task;
  }

  private async loadTasks(): Promise<void> {
    this.loading = true;
    this.notFound = false;
    this.saveError = null;
    this.loadedTasks = [];

    if (this.taskIds.length < 2 || !this.scopeParam) {
      this.notFound = true;
      this.loading = false;
      return;
    }

    const rows: Task[] = [];
    for (const id of this.taskIds) {
      const ref = this.taskDocRef(id);
      if (!ref) {
        this.notFound = true;
        this.loading = false;
        return;
      }
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        this.notFound = true;
        this.loading = false;
        return;
      }
      rows.push(this.mapDocToTask(id, snap.data() as Record<string, unknown>));
    }
    this.loadedTasks = rows;
    this.titlesDisplay = rows
      .map((t) => (t.title?.trim() ? t.title : '（無題）'))
      .join('\n');

    const first = rows[0];
    const lab = first.label?.trim();
    this.editLabel = lab || DEFAULT_TASK_LABEL_COLOR;
    this.editPriority = clampTaskPriority(first.priority);
    this.editStatus = first.status;

    const m = taskScheduleMode(first);
    if (m === 'window' && first.startAt && first.endAt) {
      this.scheduleEditMode = 'window';
      const s = timestampLikeToDate(first.startAt)!;
      const e = timestampLikeToDate(first.endAt)!;
      this.startDate = startOfLocalDate(s);
      const sh = localHourAndMinute(s);
      this.startHour = sh.hour;
      this.startMinute = sh.minute;
      this.endDate = startOfLocalDate(e);
      const eh = localHourAndMinute(e);
      this.endHour = eh.hour;
      this.endMinute = eh.minute;
      this.deadlineDate = null;
      this.deadlineHour = 0;
      this.deadlineMinute = 0;
    } else if (m === 'deadline' && first.deadline) {
      this.scheduleEditMode = 'deadline';
      const d = timestampLikeToDate(first.deadline)!;
      this.deadlineDate = startOfLocalDate(d);
      const hm = localHourAndMinute(d);
      this.deadlineHour = hm.hour;
      this.deadlineMinute = hm.minute;
      this.startDate = null;
      this.startHour = 0;
      this.startMinute = 0;
      this.endDate = null;
      this.endHour = 1;
      this.endMinute = 0;
    } else {
      this.scheduleEditMode = 'none';
      this.deadlineDate = null;
      this.deadlineHour = 0;
      this.deadlineMinute = 0;
      this.startDate = null;
      this.startHour = 0;
      this.startMinute = 0;
      this.endDate = null;
      this.endHour = 1;
      this.endMinute = 0;
    }
    this.scheduleBulkMode = 'unchanged';

    this.loading = false;
  }

  formatTimePart(n: number): string {
    return String(n).padStart(2, '0');
  }

   isProjectTaskScope(): boolean {
    return this.scopeParam !== 'private' && !this.scopeParam.startsWith('pl-');
  }

  onScheduleModeChange(mode: string): void {
    const m = mode as 'none' | 'deadline' | 'window';
    if (m === 'deadline' && !this.deadlineDate) {
      const now = new Date();
      this.deadlineDate = startOfLocalDate(now);
      const hm = localHourAndMinute(now);
      this.deadlineHour = hm.hour;
      this.deadlineMinute = hm.minute;
    } else if (m === 'window') {
      const now = new Date();
      if (!this.startDate) {
        this.startDate = startOfLocalDate(now);
        const hm = localHourAndMinute(now);
        this.startHour = hm.hour;
        this.startMinute = hm.minute;
      }
      if (!this.endDate) {
        const end = new Date(now.getTime() + 3600000);
        this.endDate = startOfLocalDate(end);
        const hm = localHourAndMinute(end);
        this.endHour = hm.hour;
        this.endMinute = hm.minute;
      }
    }
  }

  onTimeWindowChange(): void {
    const baseTime = new Date(this.startDate!.getTime());
    baseTime.setHours(this.startHour, this.startMinute, 0, 0);

    const end = new Date(baseTime.getTime() + 3600000);
    this.endDate = startOfLocalDate(end);
    const hm = localHourAndMinute(end);
    this.endHour = hm.hour;
    this.endMinute = hm.minute;
  }

  private relDeltaMs(): number {
    const d = Number(this.relDays) || 0;
    const h = Number(this.relHours) || 0;
    const mi = Number(this.relMinutes) || 0;
    return (d * 24 + h) * 3600000 + mi * 60000;
  }

  private schedulePatchForTask(t: Task): Record<string, unknown> | null {
    if (this.scheduleBulkMode === 'unchanged') {
      return null;
    }
    if (this.scheduleBulkMode === 'absolute') {
      if (this.scheduleEditMode === 'deadline') {
        const d = composeLocalDateTime(
          this.deadlineDate,
          this.deadlineHour,
          this.deadlineMinute,
        );
        if (d) {
          return {
            deadline: Timestamp.fromDate(d),
            startAt: deleteField(),
            endAt: deleteField(),
          };
        }
        return { deadline: deleteField(), startAt: deleteField(), endAt: deleteField() };
      }
      if (this.scheduleEditMode === 'window') {
        const s = composeLocalDateTime(this.startDate, this.startHour, this.startMinute);
        const e = composeLocalDateTime(this.endDate, this.endHour, this.endMinute);
        if (s && e) {
          if (e.getTime() < s.getTime()) {
            this.saveError = '終了日時は開始日時以降にしてください';
            return {};
          }
          return {
            startAt: Timestamp.fromDate(s),
            endAt: Timestamp.fromDate(e),
            deadline: deleteField(),
          };
        }
        return { deadline: deleteField(), startAt: deleteField(), endAt: deleteField() };
      }
      return { deadline: deleteField(), startAt: deleteField(), endAt: deleteField() };
    }
    const delta = this.relDeltaMs();
    if (delta === 0) {
      return null;
    }
    const m = taskScheduleMode(t);
    const out: Record<string, unknown> = {};
    if (m === 'deadline' && t.deadline) {
      const base = timestampLikeToDate(t.deadline);
      if (base) {
        out['deadline'] = Timestamp.fromDate(new Date(base.getTime() + delta));
      }
    } else if (m === 'window' && t.startAt && t.endAt) {
      const s = timestampLikeToDate(t.startAt);
      const e = timestampLikeToDate(t.endAt);
      if (s && e) {
        out['startAt'] = Timestamp.fromDate(new Date(s.getTime() + delta));
        out['endAt'] = Timestamp.fromDate(new Date(e.getTime() + delta));
      }
    }
    return Object.keys(out).length ? out : null;
  }

  async save(): Promise<void> {
    this.saveError = null;
    if (this.loadedTasks.length < 2) {
      return;
    }

    if (this.scheduleBulkMode === 'absolute' && this.scheduleEditMode === 'window') {
      const s = composeLocalDateTime(this.startDate, this.startHour, this.startMinute);
      const e = composeLocalDateTime(this.endDate, this.endHour, this.endMinute);
      if (s && e && e.getTime() < s.getTime()) {
        this.saveError = '終了日時は開始日時以降にしてください';
        return;
      }
    }

    const batch = writeBatch(this.firestore);
    const scope = taskScopeFromDetailRouteParam(this.scopeParam);

    for (const t of this.loadedTasks) {
      const id = t.id;
      if (!id) {
        continue;
      }
      const ref = this.taskDocRef(id);
      if (!ref) {
        continue;
      }
      const prev = t.status;
      const patch: Record<string, unknown> = {
        ...taskStatusTransitionPatch(this.editStatus, prev),
        label: (this.editLabel || DEFAULT_TASK_LABEL_COLOR).trim(),
        priority: clampTaskPriority(this.editPriority),
      };

      const sched = this.schedulePatchForTask(t);
      if (this.saveError) {
        return;
      }
      if (sched && Object.keys(sched).length) {
        Object.assign(patch, sched);
      }
      batch.update(ref, patch);
    }

    if (this.saveError) {
      return;
    }

    try {
      await batch.commit();
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : '保存に失敗しました';
      return;
    }

    for (const t of this.loadedTasks) {
      if (t.id) {
        try {
          await this.taskActivityLog.logUpdate(scope, {
            subjectId: t.id,
            subjectTitle: t.title || '（無題）',
          });
        } catch (e) {
          console.error('task activity log failed:', e);
        }
      }
    }

    this.navigateBack();
  }

  async deleteAll(): Promise<void> {
    this.saveError = null;
    const n = this.loadedTasks.length;
    if (n < 2) {
      return;
    }
    if (!confirm(`${n}件のタスクを削除しますか？\n選択されていない子タスクも削除されます。`)) {
      return;
    }
    const rootIds = this.loadedTasks.map((t) => t.id).filter((x): x is string => !!x);
    const targets = await this.expandDeleteCascadeEntries(rootIds);
    const batch = writeBatch(this.firestore);
    for (const { id } of targets) {
      const ref = this.taskDocRef(id);
      if (ref) {
        batch.delete(ref);
      }
    }
    try {
      await batch.commit();
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : '削除に失敗しました';
      return;
    }
    const scope = taskScopeFromDetailRouteParam(this.scopeParam);
    for (const { id, title } of targets) {
      try {
        await this.taskActivityLog.logDelete(scope, { subjectId: id, subjectTitle: title });
      } catch (e) {
        console.error('task activity log (delete) failed:', e);
      }
    }
    this.navigateBack();
  }

  /**
   * 各ルートの子ツリーを含めた削除対象を、ログ用タイトル付きで返す。
   * `getDocs` 1 回のスナップショットから `id → title` を構築するため、子タスクもタイトルが取れる。
   */
  private async expandDeleteCascadeEntries(rootIds: string[]): Promise<DeleteCascadeEntry[]> {
    const col = this.taskCollectionRef.tasksCollectionRef(this.auth.userId(), taskScopeFromDetailRouteParam(this.scopeParam));
    if (!col) {
      const byLoaded = new Map(
        this.loadedTasks
          .filter((t): t is Task & { id: string } => !!t.id)
          .map((t) => [t.id, t] as const),
      );
      return rootIds.map((id) => ({
        id,
        title: (byLoaded.get(id)?.title ?? '').trim() || '（無題）',
      }));
    }
    const snap = await getDocs(col);
    const idToTitle = new Map<string, string>();
    const byParent = new Map<string, string[]>();
    snap.forEach((d) => {
      const data = d.data() as Record<string, unknown>;
      const rawTitle = typeof data['title'] === 'string' ? data['title'].trim() : '';
      idToTitle.set(d.id, rawTitle || '（無題）');
      const p =
        typeof data['parentTaskId'] === 'string' && data['parentTaskId'].trim() !== ''
          ? data['parentTaskId'].trim()
          : null;
      if (!p) {
        return;
      }
      const arr = byParent.get(p) ?? [];
      arr.push(d.id);
      byParent.set(p, arr);
    });
    const out = new Set<string>();
    const walk = (id: string) => {
      out.add(id);
      for (const c of byParent.get(id) ?? []) {
        walk(c);
      }
    };
    for (const r of rootIds) {
      walk(r);
    }
    return [...out].map((id) => ({
      id,
      title: idToTitle.get(id) ?? '（無題）',
    }));
  }

  back(): void {
    this.navigateBack();
  }

  private navigateBack(): void {
    const q = this.route.snapshot.queryParamMap;
    const from = q.get(TASK_RETURN_QUERY.from);
    const taskView =
      from === 'calendar' ? 'calendar' : from === 'kanban' ? 'kanban' : 'list';
    const calOut =
      from === 'calendar'
        ? q.get(TASK_RETURN_QUERY.cal) === 'week'
          ? 'week'
          : q.get(TASK_RETURN_QUERY.cal) === 'day'
            ? 'day'
            : 'month'
        : null;
    const prefs: TaskListViewPrefs = {
      viewMode:
        taskView === 'calendar' ? 'calendar' : taskView === 'kanban' ? 'kanban' : 'list',
      calendarGranularity:
        calOut === 'week' || calOut === 'day' ? calOut : 'month',
      calendarViewDateIso: new Date().toISOString(),
    };
    this.projectSession.setTaskListViewPref(
      taskListViewStorageKeyFromDetailParam(this.scopeParam),
      prefs,
    );
    const queryParams: Record<string, string | null> = {
      [TASK_RETURN_QUERY.taskView]: taskView,
      [TASK_RETURN_QUERY.cal]: calOut,
    };
    const listUrl = this.scopeParam === 'private' ? `private/default` :
                this.scopeParam.startsWith('pl-') ? `private/${this.scopeParam.slice(3)}` :
                                                    `project/${this.scopeParam}`;
    void this.router.navigate([`/user-window/${listUrl}`], { queryParams });
  }

  pageTitle(): string {
    const n = this.loadedTasks.length;
    return n > 0 ? `${n}件のタスクを一括編集` : '一括編集';
  }
}
