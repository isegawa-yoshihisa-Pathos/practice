import { inject, Injectable, signal } from '@angular/core';
import { Firestore, doc, getDoc, setDoc } from '@angular/fire/firestore';

const SESSION_USERNAME_KEY = 'angular-todo-username';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly firestore = inject(Firestore);
  readonly username = signal<string | null>(null);

  constructor() {
    const stored = sessionStorage.getItem(SESSION_USERNAME_KEY);
    if (stored) {
      this.username.set(stored);
    }
  }

  async signUp(username: string, password: string): Promise<void> {
    const u = username.trim();
    if (!u || !password) {
      throw new Error('ユーザー名とパスワードを入力してください');
    }
    this.assertValidDocId(u);
    const ref = doc(this.firestore, 'accounts', u);
    const snap = await getDoc(ref);
    if (snap.exists()) {
      throw new Error('このユーザー名は既に使われています');
    }
    await setDoc(ref, { username: u, password });
  }

  async signIn(username: string, password: string): Promise<boolean> {
    const u = username.trim();
    if (!u || !password) {
      return false;
    }
    this.assertValidDocId(u);
    const ref = doc(this.firestore, 'accounts', u);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return false;
    }
    const data = snap.data() as { password?: string };
    if (data['password'] !== password) {
      return false;
    }
    this.username.set(u);
    sessionStorage.setItem(SESSION_USERNAME_KEY, u);
    return true;
  }

  signOut(): void {
    this.username.set(null);
    sessionStorage.removeItem(SESSION_USERNAME_KEY);
  }

  private assertValidDocId(username: string): void {
    if (username.includes('/')) {
      throw new Error('ユーザー名に / は使えません');
    }
  }
}
