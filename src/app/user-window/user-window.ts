import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { TaskList } from '../task-list/task-list';
import { NzPageHeaderModule } from 'ng-zorro-antd/page-header';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-user-window',
  standalone: true,
  imports: [CommonModule, FormsModule, TaskList, NzPageHeaderModule, NzButtonModule],
  templateUrl: './user-window.html',
  styleUrl: './user-window.css',
})
export class UserWindow {
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);

  signOut() {
    this.auth.signOut();
    void this.router.navigate(['/login']);
  }
}
