import {
  Component,
  inject,
  Input,
  OnChanges,
  OnDestroy,
  OnInit,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TaskListItem } from '../task-list-item/task-list-item';
import { TaskForm } from '../task-form/task-form';
import { Task } from '../../models/task';
import { clampTaskPriority } from '../task-priority';
import { sortTasks, TaskSortField } from '../task-sort';
import { NzListModule } from 'ng-zorro-antd/list';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzRadioModule } from 'ng-zorro-antd/radio';
import { Firestore, collection, addDoc, Timestamp, collectionData } from '@angular/fire/firestore';
import { map } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import { AuthService } from '../auth.service';
import { TaskScope } from '../task-scope';

@Component({
  selector: 'app-task-list',
  imports: [
    CommonModule,
    FormsModule,
    TaskListItem,
    TaskForm,
    NzListModule,
    NzSelectModule,
    NzRadioModule,
  ],
  templateUrl: './task-list.html',
  styleUrl: './task-list.css',
})
export class TaskList implements OnInit, OnDestroy, OnChanges {
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private sub?: Subscription;

  @Input() taskScope: TaskScope = { kind: 'private' };

  tasks: Task[] = [];

  /** 未選択は null（ソート条件から除外） */
  sortKey1: TaskSortField | null = null;
  sortKey2: TaskSortField | null = null;
  sortKey3: TaskSortField | null = null;
  sortAscending = true;

  readonly sortFieldOptions: { value: TaskSortField; label: string }[] = [
    { value: 'color', label: '色' },
    { value: 'deadline', label: '期日' },
    { value: 'priority', label: '優先度' },
  ];

  get displayTasks(): Task[] {
    const keys = [this.sortKey1, this.sortKey2, this.sortKey3].filter(
      (k): k is TaskSortField => k !== null,
    );
    return sortTasks(this.tasks, keys, this.sortAscending);
  }

  ngOnInit() {
    this.subscribeTasks();
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['taskScope'] && !changes['taskScope'].firstChange) {
      this.subscribeTasks();
    }
  }

  private subscribeTasks() {
    this.sub?.unsubscribe();
    this.sub = undefined;
    this.tasks = [];

    const username = this.auth.username();
    if (!username) {
      return;
    }

    const ref =
      this.taskScope.kind === 'private'
        ? collection(this.firestore, 'accounts', username, 'tasks')
        : collection(this.firestore, 'projects', this.taskScope.projectId, 'tasks');

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
          const description =
            typeof data['description'] === 'string' ? data['description'] : '';
          const priority = clampTaskPriority(data['priority']);
          return { ...data, done, label, deadline, description, priority } as Task;
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
    const col =
      this.taskScope.kind === 'private'
        ? collection(this.firestore, 'accounts', username, 'tasks')
        : collection(this.firestore, 'projects', this.taskScope.projectId, 'tasks');
    addDoc(col, task);
  }

  ngOnDestroy() {
    this.sub?.unsubscribe();
  }
}