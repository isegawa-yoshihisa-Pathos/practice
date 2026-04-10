import { Component, Input, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Task } from '../../models/task';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { deleteDoc, doc, Firestore, updateDoc } from '@angular/fire/firestore';
import { AuthService } from '../auth.service';
import { TaskScope } from '../task-scope';
import { priorityShortLabel } from '../task-priority';

@Component({
  selector: 'app-task-list-item',
  imports: [CommonModule, FormsModule, NzCheckboxModule, NzTagModule, NzButtonModule, NzIconModule],
  templateUrl: './task-list-item.html',
  styleUrl: './task-list-item.css',
})
export class TaskListItem implements OnInit {
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  ngOnInit() {}

  @Input() task: Task = {
    title: '',
    label: '',
    done: false,
    priority: 3,
    deadline: new Date(),
  };
  @Input() taskScope: TaskScope = { kind: 'private' };

  priorityLabel(): string {
    return priorityShortLabel(this.task.priority);
  }

  labelBackground(): Record<string, string> {
    const c = this.task.label?.trim();
    if (!c) {
      return {};
    }
    return { 'background-color': c };
  }

  onDoneChange(done: boolean): void {
    this.task.done = done;
    const id = this.task.id;
    const username = this.auth.username();
    if (!id || !username) {
      return;
    }
    const ref =
      this.taskScope.kind === 'private'
        ? doc(this.firestore, 'accounts', username, 'tasks', id)
        : doc(this.firestore, 'projects', this.taskScope.projectId, 'tasks', id);
    updateDoc(ref, { done }).catch((err) => console.error('updateDoc failed:', err));
  }

  isOverdue(task: Task) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return (
      !task.done &&
      task.deadline &&
      task.deadline.getTime() < start.getTime()
    );
  }

  openDetail(ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
    const id = this.task.id;
    if (!id) {
      return;
    }
    const scope =
      this.taskScope.kind === 'private' ? 'private' : this.taskScope.projectId;
    void this.router.navigate(['/task', scope, id]);
  }

  deleteTask(ev: Event): void {
    ev.preventDefault();
    ev.stopPropagation();
    const id = this.task.id;
    const username = this.auth.username();
    if (!id || !username) {
      return;
    }
    if (!confirm('このタスクを削除しますか？')) {
      return;
    }
    const ref =
      this.taskScope.kind === 'private'
        ? doc(this.firestore, 'accounts', username, 'tasks', id)
        : doc(this.firestore, 'projects', this.taskScope.projectId, 'tasks', id);
    deleteDoc(ref).catch((err) => console.error('deleteDoc failed:', err));
  }
}