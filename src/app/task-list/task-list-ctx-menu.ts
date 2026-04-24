import { Component, Output, EventEmitter, viewChild, inject } from '@angular/core';
import { MatMenuModule, MatMenuTrigger } from '@angular/material/menu';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { TaskListDataService } from './task-list-data.service';
import { Task } from '../../models/task';

@Component({
  selector: 'app-task-list-task-ctx-menu',
  standalone: true,
  imports: [MatMenuModule, MatButtonModule, MatDividerModule],
  template: `
    <button
      type="button"
      #taskCtxMenuTrigger="matMenuTrigger"
      [matMenuTriggerFor]="taskCtxMenu"
      [style.left.px]="contextMenuX"
      [style.top.px]="contextMenuY"
      class="task-ctx-menu-anchor"
      tabindex="-1"
      aria-hidden="true"
    ></button>
    <mat-menu #taskCtxMenu="matMenu">
      @if (ctxBulkMode && ctxBulkIds.length >= 2) {
        <button mat-menu-item type="button" (click)="bulkEdit.emit()">
            {{ ctxBulkIds.length }}件のタスクを編集
        </button>
        <button mat-menu-item type="button" (click)="bulkDuplicate.emit()">
            {{ ctxBulkIds.length }}件のタスクを複製
        </button>
        <mat-divider />
        <button mat-menu-item type="button" class="task-delete" (click)="bulkDelete.emit()">
            {{ ctxBulkIds.length }}件のタスクを削除
        </button>
      } @else {
        <button mat-menu-item type="button" (click)="navigateDetail.emit()">タスクを編集</button>
        <button mat-menu-item type="button" (click)="duplicate.emit()">タスクを複製</button>
        @if (ctxTask && !ctxTask.parentTaskId) {
          <button mat-menu-item type="button" (click)="createSubtask.emit()">子タスクを作成</button>
        }
        <mat-divider />
        <button mat-menu-item type="button" class="task-delete" (click)="delete.emit()">タスクを削除</button>
      }
    </mat-menu>
  `,
  styleUrl: './task-list.css',
})

export class TaskListTaskCtxMenu {
  /** アンカー位置・メニュー内容は `open()` のみで更新（親から @Input すると CD で上書きされメニューが壊れる） */
  contextMenuX = 0;
  contextMenuY = 0;
  ctxBulkMode = false;
  ctxBulkIds: string[] = [];
  ctxTask: Task | null = null;

  @Output() bulkEdit = new EventEmitter<void>();
  @Output() bulkDuplicate = new EventEmitter<void>();
  @Output() bulkDelete = new EventEmitter<void>();
  @Output() navigateDetail = new EventEmitter<void>();
  @Output() duplicate = new EventEmitter<void>();
  @Output() createSubtask = new EventEmitter<void>();
  @Output() delete = new EventEmitter<void>();

  private readonly trigger = viewChild.required(MatMenuTrigger);
  private readonly DataService = inject(TaskListDataService);

  /** 親の openTaskContextMenuAt の最後で呼ぶ */
  open(clientX: number, clientY: number, task: Task): void {
    this.ctxTask = task;
    const tid = task.id;
    if (tid && this.DataService.selectedTaskIdSet().size >= 2 && this.DataService.isTaskSelected(tid)) {
      this.ctxBulkMode = true;
      this.ctxBulkIds = [...this.DataService.selectedTaskIdSet()];
    } else {
      this.ctxBulkMode = false;
      this.ctxBulkIds = [];
    }
    this.contextMenuX = clientX;
    this.contextMenuY = clientY;
    queueMicrotask(() => this.trigger().openMenu());
  }
}