import { Component, inject, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TaskListItem } from '../task-list-item/task-list-item';
import { TaskForm } from '../task-form/task-form';
import { Task } from '../../models/task';
import { NzListModule } from 'ng-zorro-antd/list';
import { Firestore, collection, addDoc, Timestamp, collectionData } from '@angular/fire/firestore';
import { map } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-task-list',
  imports: [CommonModule, FormsModule, TaskListItem, TaskForm, NzListModule],
  templateUrl: './task-list.html',
  styleUrl: './task-list.css',
})
export class TaskList implements OnInit, OnDestroy {
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private sub?: Subscription;

  tasks: Task[] = [];

  ngOnInit() {
    const username = this.auth.username();
    if (!username) {
      return;
    }
    const ref = collection(this.firestore, 'accounts', username, 'tasks');
    this.sub = collectionData(ref, { idField: 'id' })
    .pipe(
      map((rows) =>
        (rows as Record<string, unknown>[]).map((data) => {
          const raw = data['deadline'];
          const done = Boolean(data['done']);
          const label =
            typeof data['label'] === 'string' && data['label'].trim() !== ''
              ? data['label']
              : '';
          const deadline =
            raw instanceof Timestamp
              ? raw.toDate()
              : raw instanceof Date
                ? raw
                : raw
                  ? new Date(raw as string | number)
                  : null;
          return { ...data, done,label,deadline } as Task;
        }),
      ),
    )
    .subscribe((tasks) => {
      this.tasks = tasks;
    });
  }

  addTask(task: Task) {
    const username = this.auth.username();
    if (!username) {
      return;
    }
    addDoc(collection(this.firestore, 'accounts', username, 'tasks'), task);
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }
}