import {
  Component,
  EventEmitter,
  inject,
  Input,
  OnChanges,
  OnInit,
  Output,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Task } from '../../models/task';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatButtonModule } from '@angular/material/button';
import { MatSelectModule } from '@angular/material/select';
import { MatIconModule } from '@angular/material/icon';
import { MatRadioModule } from '@angular/material/radio';
import { MatDatepickerModule } from '@angular/material/datepicker';
import {
  TASK_HOUR_OPTIONS,
  TASK_MINUTE_OPTIONS,
  composeLocalDateTime,
  localHourAndMinute,
  startOfLocalDate,
} from '../task-schedule';
import { DEFAULT_TASK_LABEL_COLOR, TASK_COLOR_CHART } from '../task-colors';
import { DEFAULT_TASK_PRIORITY, TASK_PRIORITY_OPTIONS } from '../task-priority';
import { TaskScope } from '../task-scope';
import { AuthService } from '../auth.service';
import { DEFAULT_TASK_ASSIGNEE } from '../task-assignee';
import type { ProjectMemberRow } from '../../models/project-member';
import { UserAvatar } from '../user-avatar/user-avatar';

@Component({
  selector: 'app-task-form',
  imports: [
    CommonModule,
    FormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonModule,
    MatSelectModule,
    MatIconModule,
    MatRadioModule,
    MatDatepickerModule,
    UserAvatar,
  ],
  templateUrl: './task-form.html',
  styleUrl: './task-form.css',
})
export class TaskForm implements OnInit, OnChanges {
  private readonly auth = inject(AuthService);

  ngOnInit() {
    if (this.date) {
      const now = new Date();
      this.deadlineDate = composeLocalDateTime(this.date, now.getHours(), now.getMinutes());
      this.deadlineHour = now.getHours();
      this.deadlineMinute = now.getMinutes();
      this.startDate = composeLocalDateTime(this.date, now.getHours(), now.getMinutes());
      this.startHour = now.getHours();
      this.startMinute = now.getMinutes();
    }
  }

  /** ダイアログ側の「追加」ボタン用（必須タイトルと同等の判定） */
  canSubmit(): boolean {
    return (this.newTask.title ?? '').trim().length > 0;
  }

  readonly colorChart = TASK_COLOR_CHART;
  readonly priorityOptions = TASK_PRIORITY_OPTIONS;

  /** 担当が個人メンバー以外（未設定）のとき */
  readonly assigneeNone = '';

  @Input() taskScope: TaskScope = { kind: 'private', privateListId: 'default' };
  @Input() projectMembers: ProjectMemberRow[] = [];
  @Input() date: Date | null = null;

  /** 選択中の担当者（トリガーにアイコン＋表示名を出すため） */
  selectedAssigneeMember(): ProjectMemberRow | null {
    const id = this.newTask.assignee;
    if (typeof id !== 'string' || id.trim() === '') {
      return null;
    }
    return this.projectMembers.find((m) => m.userId === id) ?? null;
  }

  @Output() addTask = new EventEmitter<Task>();

  newTask: Task = this.emptyTask();

  /** 締切と開始終了は同時に持たない */
  scheduleMode: 'none' | 'deadline' | 'window' = 'none';
  deadlineDate: Date | null = null;
  deadlineHour = 0;
  deadlineMinute = 0;
  startDate: Date | null = null;
  startHour = 0;
  startMinute = 0;
  endDate: Date | null = null;
  endHour = 1;
  endMinute = 0;

  readonly hourOptions = TASK_HOUR_OPTIONS;
  readonly minuteOptions = TASK_MINUTE_OPTIONS;

  formatTimePart(n: number): string {
    return String(n).padStart(2, '0');
  }

  private emptyTask(): Task {
    return {
      title: '',
      label: DEFAULT_TASK_LABEL_COLOR,
      status: 'todo',
      priority: DEFAULT_TASK_PRIORITY,
      deadline: null,
      startAt: null,
      endAt: null,
      description: '',
      assignee: DEFAULT_TASK_ASSIGNEE(this.auth.userId()) ?? '',
    };
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['taskScope']) {
      this.newTask.assignee =
        this.taskScope.kind === 'project'
          ? DEFAULT_TASK_ASSIGNEE(this.auth.userId()) ?? ''
          : null;
    }
  }

  onScheduleModeChange(mode: string): void {
    const m = mode as 'none' | 'deadline' | 'window';
    if (m === 'deadline') {
      const now = (this.deadlineDate ?? new Date());
      this.deadlineDate = now;
      const hm = localHourAndMinute(now);
      this.deadlineHour = hm.hour;
      this.deadlineMinute = hm.minute;
    } else if (m === 'window') {
      const now = (this.startDate ?? new Date());
      if (!this.startDate) {
        this.startDate = now;
        const hm = localHourAndMinute(now);
        this.startHour = hm.hour;
        this.startMinute = hm.minute;
      }
      if (!this.endDate) {
        const end = new Date(now.getTime() + 3600000);
        this.endDate = end;
        const hm = localHourAndMinute(end);
        this.endHour = hm.hour;
        this.endMinute = hm.minute;
      }
    }
  }

  onTimeWindowChange(): void {
    const baseTime = new Date(this.startDate!.getTime());
    baseTime.setHours(this.startHour, this.startMinute, 0, 0);

    const end = new Date(baseTime.getTime() + 3600000);
    this.endDate = startOfLocalDate(end);
    const hm = localHourAndMinute(end);
    this.endHour = hm.hour;
    this.endMinute = hm.minute;
  }

  onTitleKeydownEnter(event: Event): void {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }
    if (event.isComposing) {
      return;
    }
    event.preventDefault();
    this.submit();
  }

  submit(): void {
    if (!this.canSubmit()) {
      return;
    }
    let deadline: Date | null = null;
    let startAt: Date | null = null;
    let endAt: Date | null = null;
    if (this.scheduleMode === 'deadline') {
      deadline = composeLocalDateTime(this.deadlineDate, this.deadlineHour, this.deadlineMinute);
    } else if (this.scheduleMode === 'window') {
      startAt = composeLocalDateTime(this.startDate, this.startHour, this.startMinute);
      endAt = composeLocalDateTime(this.endDate, this.endHour, this.endMinute);
      if (!startAt || !endAt) {
        alert('開始と終了の日時を両方入力してください');
        return;
      }
      if (endAt.getTime() < startAt.getTime()) {
        alert('終了は開始以降にしてください');
        return;
      }
    }
    const base: Task = {
      title: this.newTask.title,
      label: this.newTask.label?.trim() || DEFAULT_TASK_LABEL_COLOR,
      status: 'todo',
      priority: this.newTask.priority,
      deadline,
      startAt,
      endAt,
      description: '',
    };
    if (this.taskScope.kind === 'project') {
      const a =
        typeof this.newTask.assignee === 'string' ? this.newTask.assignee.trim() : '';
      base.assignee = a || null;
    }
    this.addTask.emit(base);
    this.newTask = this.emptyTask();
    this.scheduleMode = 'none';
    this.date = null;
    this.deadlineDate = null;
    this.deadlineHour = 0;
    this.deadlineMinute = 0;
    this.startDate = null;
    this.startHour = 0;
    this.startMinute = 0;
    this.endDate = null;
    this.endHour = 1;
    this.endMinute = 0;
  }
}
