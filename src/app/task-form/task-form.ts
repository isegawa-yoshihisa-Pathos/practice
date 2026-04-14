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
import {
  defaultScheduleDatetimeLocalNow,
  defaultScheduleDatetimeLocalOneHourLater,
  fromDatetimeLocalString,
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
    UserAvatar,
  ],
  templateUrl: './task-form.html',
  styleUrl: './task-form.css',
})
export class TaskForm implements OnInit, OnChanges {
  private readonly auth = inject(AuthService);

  ngOnInit() {}

  readonly colorChart = TASK_COLOR_CHART;
  readonly priorityOptions = TASK_PRIORITY_OPTIONS;

  /** 担当が個人メンバー以外（未設定）のとき */
  readonly assigneeNone = '';

  @Input() taskScope: TaskScope = { kind: 'private', privateListId: 'default' };
  @Input() projectMembers: ProjectMemberRow[] = [];

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
  deadlineStr = '';
  startStr = '';
  endStr = '';

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

  /** 空欄のときだけ現在／1時間後を入れる（手入力を上書きしない） */
  onScheduleModeChange(mode: string): void {
    const m = mode as 'none' | 'deadline' | 'window';
    if (m === 'deadline' && !this.deadlineStr.trim()) {
      this.deadlineStr = defaultScheduleDatetimeLocalNow();
    } else if (m === 'window') {
      if (!this.startStr.trim()) {
        this.startStr = defaultScheduleDatetimeLocalNow();
      }
      if (!this.endStr.trim()) {
        this.endStr = defaultScheduleDatetimeLocalOneHourLater();
      }
    }
  }

  submit(): void {
    let deadline: Date | null = null;
    let startAt: Date | null = null;
    let endAt: Date | null = null;
    if (this.scheduleMode === 'deadline') {
      deadline = fromDatetimeLocalString(this.deadlineStr);
    } else if (this.scheduleMode === 'window') {
      startAt = fromDatetimeLocalString(this.startStr);
      endAt = fromDatetimeLocalString(this.endStr);
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
    this.deadlineStr = '';
    this.startStr = '';
    this.endStr = '';
  }
}
