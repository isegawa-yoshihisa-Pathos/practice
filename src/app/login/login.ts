import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { AuthService } from '../auth.service';

@Component({
  selector: 'app-login',
  imports: [CommonModule, FormsModule],
  templateUrl: './login.html',
  styleUrl: './login.css',
})
export class Login {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  public username: string = '';
  public password: string = '';

  async signIn() {
    try {
      const ok = await this.auth.signIn(this.username, this.password);
      if (ok) {
        await this.router.navigate(['/user-window']);
      } else {
        alert('ユーザー名またはパスワードが正しくありません');
      }
    } catch (e) {
      alert(e instanceof Error ? e.message : 'ログインに失敗しました');
    }
  }

  makeAccount() {
    void this.router.navigate(['/signup']);
  }
}
