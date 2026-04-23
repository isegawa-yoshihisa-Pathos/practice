import { Component, DestroyRef, inject, OnDestroy, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
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
import { mapFirestoreDocToTask } from '../task-firestore-mutation';
import { TaskCollectionReferenceService } from '../task-collection-reference.service';

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
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly taskCollectionRef = inject(TaskCollectionReferenceService);
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
    subjectTitle: string;
    subjectId: string;
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

    const tasksRef = this.taskCollectionRef.tasksCollectionRef(userId, this.taskScope);
    if (!tasksRef) return;
    this.tasksSub = collectionData(tasksRef, { idField: 'id' })
      .pipe(
        map((rows) =>
          (rows as Record<string, unknown>[]).map((data) => mapFirestoreDocToTask(data)),
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
              raw === 'create' || raw === 'update' || raw === 'delete' || raw === 'createKanban' || raw === 'updateKanban' || raw === 'deleteKanban' ? raw : 'update';
            const subjectTitle =
              typeof data['subjectTitle'] === 'string' ? data['subjectTitle'] : '';
            const subjectId = typeof data['subjectId'] === 'string' ? data['subjectId'] : '';
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
              actionLabel: action === 'create' ? 'タスクを追加' :
                           action === 'delete' ? 'タスクを削除' : 
                           action === 'update' ? 'タスクを編集' : 
                           action === 'createKanban' ? 'カンバンを追加' :
                           action === 'updateKanban' ? 'カンバン名を編集' :
                           action === 'deleteKanban' ? 'カンバンを削除' : '不明な操作',
              actorDisplayName,
              subjectTitle: subjectTitle || '（無題）',
              subjectId,
            };
          }),
        ),
      )
      .subscribe((rows) => {
        this.activityRows = rows;
      });
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
    const listUrl = this.scopeParam === 'private' ? `private/default` :
                this.scopeParam.startsWith('pl-') ? `private/${this.scopeParam.slice(3)}` :
                                                    `project/${this.scopeParam}`;
    void this.router.navigate([`/user-window/${listUrl}`]);
  }
}
