import { Component, EventEmitter, Input, OnInit, Output, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { Task } from '../../models/task';
import {
  nextTaskStatus,
  taskStatusLabel,
  type TaskStatus,
} from '../../models/task-status';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { doc, Firestore, updateDoc } from '@angular/fire/firestore';
import { AuthService } from '../auth.service';
import { TaskScope, taskDetailScopeParam } from '../task-scope';
import { priorityShortLabel } from '../task-priority';
import {
  displayEllipsis,
  isDisplayTruncated,
  TASK_TITLE_DISPLAY_MAX_CHARS,
} from '../display-ellipsis';
import { saveTaskShellScrollPosition } from '../task-shell-scroll';
import { isTaskOverdue, taskScheduleMode } from '../task-schedule';
import { UserAvatar } from '../user-avatar/user-avatar';
import { MatTooltipModule } from '@angular/material/tooltip';
import type { ProjectMemberRow } from '../../models/project-member';
import { TaskActivityLogService } from '../task-activity-log.service';
import { taskStatusTransitionPatch } from '../task-firestore-mutation';

@Component({
  selector: 'app-task-list-item',
  imports: [CommonModule, MatButtonModule, MatIconModule, DragDropModule, UserAvatar, MatTooltipModule],
  templateUrl: './task-list-item.html',
  styleUrl: './task-list-item.css',
})
export class TaskListItem implements OnInit {
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly taskActivityLog = inject(TaskActivityLogService);

  ngOnInit() {}

  @Input() task: Task = {
    title: '',
    label: '',
    status: 'todo',
    priority: 3,
    deadline: null,
  };
  @Input() taskScope: TaskScope = { kind: 'private', privateListId: 'default' };
  /** プロジェクト時、担当表示名の解決用 */
  @Input() projectMembers: ProjectMemberRow[] = [];
  @Input() showDragHandle = false;
  /** 子タスク行（インデント・ドラッグは親の範囲内のみ） */
  @Input() isSubtask = false;
  /** リスト／カンバンでラベル帯にトグルを出す（ルート行） */
  @Input() showSubtasksToggle = false;
  /** フィルタ後に子が1件以上あるか（子ありは ▼/▲、子なしは ▽ と aria 用） */
  @Input() hasSubtasks = false;
  @Input() subtasksExpanded = false;

  @Output() toggleSubtasksUi = new EventEmitter<void>();
  @Output() contextMenuRequest = new EventEmitter<{
    clientX: number;
    clientY: number;
    task: Task;
  }>();
  @Output() deleteRequested = new EventEmitter<Task>();

  statusLabel(): string {
    return taskStatusLabel(this.task.status);
  }

  priorityLabel(): string {
    return priorityShortLabel(this.task.priority);
  }

  taskTitleDisplay(): string {
    return displayEllipsis(this.task.title, TASK_TITLE_DISPLAY_MAX_CHARS);
  }

  /** 省略時のみホバーで全文 */
  taskTitleTooltip(): string | null {
    const t = this.task.title ?? '';
    return isDisplayTruncated(t, TASK_TITLE_DISPLAY_MAX_CHARS) ? t : null;
  }

  /** タスクの assignee はユーザーID。ツールチップ用に表示名を返す */
  assigneeDisplay(): string {
    const a = this.task.assignee?.trim();
    if (!a) {
      return '';
    }
    const m = this.projectMembers.find((x) => x.userId === a);
    return m?.displayName ?? a;
  }

  assigneeAvatarUrl(): string | null {
    const a = this.task.assignee?.trim();
    if (!a) {
      return null;
    }
    const m = this.projectMembers.find((x) => x.userId === a);
    return m?.avatarUrl ?? null;
  }

  /** 左の色帯・行の背景トーンに使用 */
  labelStripColor(): string {
    const c = this.task.label?.trim();
    return c || '#e0e0e0';
  }

  private persistStatus(status: TaskStatus): void {
    const id = this.task.id;
    const userId = this.auth.userId();
    if (!id || !userId) {
      return;
    }
    const ref = this.taskDocRef(id);
    if (!ref) {
      return;
    }
    const prev = this.task.status;
    this.task.status = status;
    void updateDoc(ref, taskStatusTransitionPatch(status, prev))
      .then(() =>
        this.taskActivityLog.logUpdate(this.taskScope, {
          taskId: id,
          taskTitle: this.task.title,
        }),
      )
      .catch((err) => console.error('updateDoc failed:', err));
  }

  /** 色帯または行（操作・ドラッグ以外）のクリックで進捗を循環 */
  cycleProgress(ev: MouseEvent): void {
    const el = ev.target as HTMLElement | null;
    if (!el) {
      return;
    }
    if (
      el.closest(
        'button, a, input, textarea, .drag-handle, .actions, .subtasks-toggle, .label-strip',
      )
    ) {
      return;
    }
    ev.preventDefault();
    this.persistStatus(nextTaskStatus(this.task.status));
  }

  onTaskMainKeydown(ev: KeyboardEvent): void {
    if (ev.key !== 'Enter' && ev.key !== ' ') {
      return;
    }
    ev.preventDefault();
    this.persistStatus(nextTaskStatus(this.task.status));
  }

  isOverdue(task: Task): boolean {
    return isTaskOverdue(task);
  }

  /** 一覧センターに表示する予定テキスト（なければ null） */
  scheduleTagText(task: Task): string | null {
    const m = taskScheduleMode(task);
    if (m === 'deadline' && task.deadline) {
      const d = task.deadline;
      return `締切 ${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    if (m === 'window' && task.startAt && task.endAt) {
      const s = new Date(task.startAt);
      const e = new Date(task.endAt);
      const fd = (x: Date) =>
        `${x.getFullYear()}/${String(x.getMonth() + 1).padStart(2, '0')}/${String(x.getDate()).padStart(2, '0')} ${String(x.getHours()).padStart(2, '0')}:${String(x.getMinutes()).padStart(2, '0')}`;
      return `${fd(s)} 〜 ${fd(e)}`;
    }
    return null;
  }

  openDetail(ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
    const id = this.task.id;
    if (!id) {
      return;
    }
    const scope = taskDetailScopeParam(this.taskScope);
    saveTaskShellScrollPosition();
    void this.router.navigate(['/task', scope, id], {
      queryParams: { from: 'list' },
    });
  }

  deleteTask(ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.deleteRequested.emit(this.task);
  }

  onRowContextMenu(ev: MouseEvent): void {
    ev.preventDefault();
    this.contextMenuRequest.emit({
      clientX: ev.clientX,
      clientY: ev.clientY,
      task: this.task,
    });
  }

  onSubtasksToggleClick(ev: MouseEvent): void {
    ev.preventDefault();
    ev.stopPropagation();
    this.toggleSubtasksUi.emit();
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
}
