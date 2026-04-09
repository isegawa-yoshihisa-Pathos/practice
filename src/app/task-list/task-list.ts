import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TaskListItem } from '../task-list-item/task-list-item';
import { TaskForm } from '../task-form/task-form';
import { Task } from '../../models/task';
import { NzListModule } from 'ng-zorro-antd/list';
import { Firestore,collection, addDoc, Timestamp, collectionData  } from '@angular/fire/firestore';
import { map } from 'rxjs/operators';
import { Subscription } from 'rxjs';

@Component({
  selector: 'app-task-list',
  imports: [CommonModule, FormsModule, TaskListItem, TaskForm, NzListModule],
  templateUrl: './task-list.html',
  styleUrl: './task-list.css',
})
export class TaskList {
  constructor() { }

  private readonly firestore = inject(Firestore);
  private sub?: Subscription;

  tasks: Task[] = [];

ngOnInit() {
  const ref = collection(this.firestore, 'tasks');
  this.sub = collectionData(ref, { idField: 'id' })
    .pipe(
      map((rows) =>
        (rows as Record<string, unknown>[]).map((data) => {
          const raw = data['deadline'];
          const deadline =
            raw instanceof Timestamp
              ? raw.toDate()
              : raw instanceof Date
                ? raw
                : raw
                  ? new Date(raw as string | number)
                  : null;
          return { ...data, deadline } as Task;
        }),
      ),
    )
    .subscribe((tasks) => {
      this.tasks = tasks;
    });
}

  addTask(task: Task) {
    addDoc(collection(this.firestore, 'tasks'), task);
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }
}