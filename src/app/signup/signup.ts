import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-signup',
  imports: [CommonModule, FormsModule],
  templateUrl: './signup.html',
  styleUrl: './signup.css',
})
export class SignUp {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  username: string = '';
  password: string = '';

  async signUp() {
    try {
      await this.auth.signUp(this.username, this.password);
      await this.router.navigate(['/login']);
    } catch (e) {
      alert(e instanceof Error ? e.message : 'アカウント作成に失敗しました');
    }
  }

  backToLogin() {
    void this.router.navigate(['/login']);
  }
}
