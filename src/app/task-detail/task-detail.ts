import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  Firestore,
  doc,
  getDoc,
  updateDoc,
  deleteField,
  Timestamp,
} from '@angular/fire/firestore';
import { AuthService } from '../auth.service';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzDatePickerModule } from 'ng-zorro-antd/date-picker';
import { DEFAULT_TASK_LABEL_COLOR, TASK_COLOR_CHART } from '../task-colors';
import {
  clampTaskPriority,
  DEFAULT_TASK_PRIORITY,
  TASK_PRIORITY_OPTIONS,
} from '../task-priority';
import { NzSelectModule } from 'ng-zorro-antd/select';

@Component({
  selector: 'app-task-detail',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    NzButtonModule,
    NzInputModule,
    NzDatePickerModule,
    NzSelectModule,
  ],
  templateUrl: './task-detail.html',
  styleUrl: './task-detail.css',
})
export class TaskDetail implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly colorChart = TASK_COLOR_CHART;
  readonly priorityOptions = TASK_PRIORITY_OPTIONS;

  loading = true;
  notFound = false;
  saveError: string | null = null;

  scopeParam = '';
  taskId = '';

  editTitle = '';
  editLabel: string = DEFAULT_TASK_LABEL_COLOR;
  editPriority = DEFAULT_TASK_PRIORITY;
  editDeadline: Date | null = null;
  editDescription = '';

  ngOnInit(): void {
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      this.scopeParam = params.get('scope') ?? '';
      this.taskId = params.get('taskId') ?? '';
      void this.load();
    });
  }

  private taskDocRef() {
    const username = this.auth.username();
    if (!username || !this.taskId) {
      return null;
    }
    if (this.scopeParam === 'private') {
      return doc(this.firestore, 'accounts', username, 'tasks', this.taskId);
    }
    return doc(this.firestore, 'projects', this.scopeParam, 'tasks', this.taskId);
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.notFound = false;
    this.saveError = null;
    const ref = this.taskDocRef();
    if (!ref) {
      this.notFound = true;
      this.loading = false;
      return;
    }
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      this.notFound = true;
      this.loading = false;
      return;
    }
    const data = snap.data() as Record<string, unknown>;
    this.editTitle = typeof data['title'] === 'string' ? data['title'] : '';
    const lab = data['label'];
    this.editLabel =
      typeof lab === 'string' && lab.trim() !== '' ? lab : DEFAULT_TASK_LABEL_COLOR;
    const raw = data['deadline'];
    this.editDeadline =
      raw instanceof Timestamp
        ? raw.toDate()
        : raw instanceof Date
          ? raw
          : raw
            ? new Date(raw as string | number)
            : null;
    this.editDescription =
      typeof data['description'] === 'string' ? data['description'] : '';
    this.editPriority = clampTaskPriority(data['priority']);
    this.loading = false;
  }

  async save(): Promise<void> {
    this.saveError = null;
    const ref = this.taskDocRef();
    if (!ref) {
      return;
    }
    const payload: Record<string, unknown> = {
      title: this.editTitle.trim() || '（無題）',
      label: this.editLabel.trim() || DEFAULT_TASK_LABEL_COLOR,
      priority: clampTaskPriority(this.editPriority),
      description: this.editDescription,
    };
    if (this.editDeadline) {
      payload['deadline'] = Timestamp.fromDate(new Date(this.editDeadline));
    } else {
      payload['deadline'] = deleteField();
    }
    try {
      await updateDoc(ref, payload);
      void this.router.navigate(['/user-window']);
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : '保存に失敗しました';
    }
  }

  back(): void {
    void this.router.navigate(['/user-window']);
  }

  pageTitle(): string {
    return this.editTitle.trim() || 'タスク詳細';
  }
}
