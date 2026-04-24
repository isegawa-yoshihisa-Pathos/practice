import { Injectable, inject } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { TaskScope } from '../task-scope';
import { Task } from '../../models/task';
import { TaskListDataService } from './task-list-data.service';
import { saveTaskShellScrollPosition } from '../task-shell-scroll';
import { TaskFormDialog } from '../task-form-dialog/task-form-dialog';
import { TaskDuplicateDialog } from '../task-duplicate-dialog/task-duplicate-dialog';
import type { ProjectMemberRow } from '../../models/project-member';
import { taskDetailScopeParam } from '../task-scope';
import type { TaskCalendarGranularity } from '../task-calendar/task-calendar';


@Injectable()
export class TaskListContextActionsService {
  calendarGranularity: TaskCalendarGranularity = 'month';
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly DataService = inject(TaskListDataService);

  openAddTask(taskScope: TaskScope, projectMembers: ProjectMemberRow[], date: Date|null, onSaved: (task: Task) => void): void {
    const ref = this.dialog.open(TaskFormDialog, {
      width: 'min(96vw, 560px)',
      autoFocus: 'first-tabbable',
      data: {
        taskScope: taskScope,
        projectMembers: projectMembers,
        date,
      },
    });
    ref.afterClosed().subscribe((task: Task | undefined) => {
      if (task) {
        onSaved(task);
      }
    });
  }

  openAddSubtask(taskScope: TaskScope, projectMembers: ProjectMemberRow[], parent: Task, date: Date|null, onSaved: (task: Task) => void): void {
    const ref = this.dialog.open(TaskFormDialog, {
      width: 'min(96vw, 560px)',
      autoFocus: 'first-tabbable',
      data: {
        taskScope: taskScope,
        projectMembers: projectMembers,
        dialogMode: 'subtask' as const,
        parentTask: parent,
        date,
      },
    });
    ref.afterClosed().subscribe((task: Task | undefined) => {
      if (task) {
        onSaved(task);
      }
    });
  }

  navigateToDetail(task: Task, taskscope: TaskScope, from: 'list' | 'calendar' | 'kanban'): void {
    saveTaskShellScrollPosition();
    void this.router.navigate(['/task', taskDetailScopeParam(taskscope), task.id], {
        queryParams: {
          from,
          ...(from === 'calendar' ? { cal: this.calendarGranularity } : {}),
        },
      });
  }

  openDuplicateDialog(ctxBulkMode: boolean, ctxBulkIds: string[], ctxTask: Task | null, taskScope: TaskScope): void {
    const tasks: Task[] = [];
    if (ctxBulkMode && ctxBulkIds.length >= 2) {
        const byId = new Map(this.DataService.tasks().map((t) => [t.id, t]));
        for (const id of ctxBulkIds) {
          const t = byId.get(id);
          if (t) {
            tasks.push(t);
          }
        }
      } else if (ctxTask?.id) {
        tasks.push(ctxTask);
      }
      if (tasks.length === 0) {
        return;
      }
      this.dialog.open(TaskDuplicateDialog, {
        width: 'min(520px, 92vw)',
        autoFocus: 'first-tabbable',
        data: {
          tasks,
          taskScope: taskScope,
        },
      });
  }
}