import { Component, Input, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Task } from '../../models/task';
import { NzCheckboxModule } from 'ng-zorro-antd/checkbox';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { doc, Firestore, updateDoc } from '@angular/fire/firestore';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-task-list-item',
  imports: [CommonModule, FormsModule, NzCheckboxModule, NzTagModule],
  templateUrl: './task-list-item.html',
  styleUrl: './task-list-item.css',
})
export class TaskListItem implements OnInit {
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);

  ngOnInit() {}

  @Input() task: Task = { title: '', label: '', done: false, deadline: new Date() };

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
    const ref = doc(this.firestore, 'accounts', username, 'tasks', id);
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
}