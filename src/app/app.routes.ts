import { Routes } from '@angular/router';
import { Login } from './login/login';
import { UserWindow } from './user-window/user-window';
import { SignUp } from './signup/signup';
import { authGuard } from './auth.guard';

export const routes: Routes = [
  { path: '', redirectTo: 'login', pathMatch: 'full' },
  { path: 'login', component: Login },
  { path: 'user-window', component: UserWindow, canActivate: [authGuard] },
  { path: 'signup', component: SignUp },
];