import { Component, DestroyRef, inject, OnDestroy, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule, Location } from '@angular/common';
import { ActivatedRoute, Router } from '@angular/router';
import {
  Firestore,
  collection,
  collectionData,
  limit,
  orderBy,
  query,
} from '@angular/fire/firestore';
import { map } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import { MatButtonModule } from '@angular/material/button';
import { AuthService } from '../auth.service';
import { TaskScope, taskScopeFromDetailRouteParam } from '../task-scope';
import { Task } from '../../models/task';
import {
  normalizeTaskStatusFromDoc,
} from '../../models/task-status';
import { clampTaskPriority } from '../task-priority';
import { timestampLikeToDate } from '../task-schedule';
import { TASK_STATUS_OPTIONS } from '../../models/task-status';
import {
  countCompletedInLastDays,
  countCreatedInLastDays,
  countDueInNextDays,
  countStatusBreakdown,
  countUpdatedInLastDays,
  pieGradientFromBreakdown,
} from '../task-report-stats';
import type { TaskActivityAction } from '../task-activity-log.service';

@Component({
  standalone: true,
  selector: 'app-task-report',
  imports: [CommonModule, MatButtonModule],
  templateUrl: './task-report.html',
  styleUrl: './task-report.css',
})
export class TaskReport implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  private tasksSub?: Subscription;
  private logSub?: Subscription;

  scopeParam = '';
  taskScope: TaskScope = { kind: 'private', privateListId: 'default' };
  loading = true;
  tasks: Task[] = [];

  pieGradient: string | null = null;
  breakdown = { todo: 0, in_progress: 0, done: 0 };
  readonly statusLegend = TASK_STATUS_OPTIONS;

  addedLast7 = 0;
  completedLast7 = 0;
  updatedLast7 = 0;
  dueNext7 = 0;

  activityRows: {
    id: string;
    at: Date | null;
    action: TaskActivityAction;
    actionLabel: string;
    actorDisplayName: string;
    taskTitle: string;
    taskId: string;
  }[] = [];

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.scopeParam = params.get('scope') ?? '';
      this.taskScope = taskScopeFromDetailRouteParam(this.scopeParam);
      this.subscribeData();
    });
  }

  ngOnDestroy(): void {
    this.tasksSub?.unsubscribe();
    this.logSub?.unsubscribe();
  }

  private subscribeData(): void {
    this.tasksSub?.unsubscribe();
    this.logSub?.unsubscribe();
    this.loading = true;
    const userId = this.auth.userId();
    if (!userId) {
      void this.router.navigate(['/login']);
      return;
    }

    const tasksRef = this.tasksCollectionRef(userId, this.taskScope);
    this.tasksSub = collectionData(tasksRef, { idField: 'id' })
      .pipe(
        map((rows) =>
          (rows as Record<string, unknown>[]).map((data) => this.mapTaskDoc(data)),
        ),
      )
      .subscribe((tasks) => {
        this.tasks = tasks;
        this.recomputeStats();
        this.loading = false;
      });

    const logRef = this.activityLogCollectionRef(userId, this.taskScope);
    const q = query(logRef, orderBy('at', 'desc'), limit(100));
    this.logSub = collectionData(q, { idField: 'id' })
      .pipe(
        map((rows) =>
          (rows as Record<string, unknown>[]).map((data) => {
            const id = String(data['id'] ?? '');
            const at = timestampLikeToDate(data['at']);
            const raw = data['action'];
            const action: TaskActivityAction =
              raw === 'create' || raw === 'update' || raw === 'delete' ? raw : 'update';
            const taskTitle =
              typeof data['taskTitle'] === 'string' ? data['taskTitle'] : '';
            const taskId = typeof data['taskId'] === 'string' ? data['taskId'] : '';
            const actorDisplayName =
              typeof data['actorDisplayName'] === 'string' && data['actorDisplayName'].trim() !== ''
                ? data['actorDisplayName'].trim()
                : typeof data['actorUserId'] === 'string'
                  ? data['actorUserId']
                  : '';
            return {
              id,
              at,
              action,
              actionLabel: action === 'create' ? '追加' : action === 'delete' ? '削除' : '編集',
              actorDisplayName,
              taskTitle: taskTitle || '（無題）',
              taskId,
            };
          }),
        ),
      )
      .subscribe((rows) => {
        this.activityRows = rows;
      });
  }

  private mapTaskDoc(data: Record<string, unknown>): Task {
    const status = normalizeTaskStatusFromDoc(data);
    const label =
      typeof data['label'] === 'string' && data['label'].trim() !== '' ? data['label'] : '';
    const deadline = timestampLikeToDate(data['deadline']);
    const startAt = timestampLikeToDate(data['startAt']);
    const endAt = timestampLikeToDate(data['endAt']);
    const description = typeof data['description'] === 'string' ? data['description'] : '';
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
      typeof rawParent === 'string' && rawParent.trim() !== '' ? rawParent.trim() : null;
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
  }

  private tasksCollectionRef(userId: string, scope: TaskScope) {
    if (scope.kind === 'project') {
      return collection(this.firestore, 'projects', scope.projectId, 'tasks');
    }
    const pid = scope.privateListId;
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

  private activityLogCollectionRef(userId: string, scope: TaskScope) {
    if (scope.kind === 'project') {
      return collection(this.firestore, 'projects', scope.projectId, 'taskActivityLog');
    }
    const pid = scope.privateListId;
    return pid === 'default'
      ? collection(this.firestore, 'accounts', userId, 'taskActivityLog')
      : collection(
          this.firestore,
          'accounts',
          userId,
          'privateTaskLists',
          pid,
          'taskActivityLog',
        );
  }

  private recomputeStats(): void {
    const now = new Date();
    const days = 7;
    this.breakdown = countStatusBreakdown(this.tasks);
    this.pieGradient = pieGradientFromBreakdown(this.breakdown);
    this.addedLast7 = countCreatedInLastDays(this.tasks, now, days);
    this.completedLast7 = countCompletedInLastDays(this.tasks, now, days);
    this.updatedLast7 = countUpdatedInLastDays(this.tasks, now, days);
    this.dueNext7 = countDueInNextDays(this.tasks, now, days);
  }

  back(): void {
    if (window.history.length > 1) {
      this.location.back();
    } else {
      void this.router.navigate(['/user-window']);
    }
  }
}
