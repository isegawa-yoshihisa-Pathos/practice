import { Component, EventEmitter, OnInit, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Task } from '../../models/task';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzDatePickerModule } from 'ng-zorro-antd/date-picker';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { DEFAULT_TASK_LABEL_COLOR, TASK_COLOR_CHART } from '../task-colors';

@Component({
  selector: 'app-task-form',
  imports: [CommonModule, FormsModule, NzInputModule, NzDatePickerModule, NzButtonModule],
  templateUrl: './task-form.html',
  styleUrl: './task-form.css',
})
export class TaskForm implements OnInit {
  constructor() {}

  ngOnInit() {}

  readonly colorChart = TASK_COLOR_CHART;

  @Output() addTask = new EventEmitter<Task>();

  newTask: Task = {
    title: '',
    label: DEFAULT_TASK_LABEL_COLOR,
    done: false,
    deadline: null,
  };

  submit(): void {
    this.addTask.emit({
      title: this.newTask.title,
      label: this.newTask.label?.trim() || DEFAULT_TASK_LABEL_COLOR,
      done: false,
      deadline: this.newTask.deadline ? new Date(this.newTask.deadline) : null,
    });
    this.newTask = {
      title: '',
      label: DEFAULT_TASK_LABEL_COLOR,
      done: false,
      deadline: null,
    };
  }
}
