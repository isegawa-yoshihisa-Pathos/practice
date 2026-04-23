import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { TaskForm } from '../task-form/task-form';
import { Task } from '../../models/task';
import { TaskScope } from '../task-scope';
import type { ProjectMemberRow } from '../../models/project-member';

export interface TaskFormDialogData {
  taskScope: TaskScope;
  projectMembers: ProjectMemberRow[];
  date?: Date;
  dialogMode?: 'default' | 'subtask';
  parentTask?: Task;
}

@Component({
  selector: 'app-task-form-dialog',
  standalone: true,
  imports: [CommonModule, MatDialogModule, MatButtonModule, TaskForm],
  templateUrl: './task-form-dialog.html',
  styleUrl: './task-form-dialog.css',
})
export class TaskFormDialog {
  private readonly dialogRef = inject(MatDialogRef<TaskFormDialog, Task | undefined>);
  readonly data = inject<TaskFormDialogData>(MAT_DIALOG_DATA);

  onAdd(task: Task): void {
    this.dialogRef.close(task);
  }

  cancel(): void {
    this.dialogRef.close(undefined);
  }
}
