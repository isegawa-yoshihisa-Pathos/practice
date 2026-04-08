import { Component, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css'
})

export class App {
  tasks = [
    {title: '牛乳を買う', done: false, deadline: new Date('2026-04-09')},
    {title: '可燃ゴミを出す', done: true, deadline: new Date('2026-04-01')},
    {title: '銀行に行く', done: false, deadline: new Date('2026-04-02')},
  ];

  today: Date = new Date();

  newTask = {
    title: '',
    deadline: this.today,
  };

  addTask() {
    this.tasks.push({title: this.newTask.title, done: false, deadline: this.newTask.deadline});
    this.newTask = {
      title: '',
      deadline: this.today,
    };
  }

  isOverdue(task: any) {
    return !task.done && task.deadline.getTime() < this.today.getTime();
  }
}
