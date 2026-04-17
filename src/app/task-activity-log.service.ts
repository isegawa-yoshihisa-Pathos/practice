import { inject, Injectable } from '@angular/core';
import {
  Firestore,
  collection,
  addDoc,
  serverTimestamp,
} from '@angular/fire/firestore';
import { AuthService } from './auth.service';
import type { TaskScope } from './task-scope';

export type TaskActivityAction = 'create' | 'update' | 'delete';

@Injectable({ providedIn: 'root' })
export class TaskActivityLogService {
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);

  private logCollectionRef(scope: TaskScope, userId: string) {
    if (scope.kind === 'project') {
      return collection(this.firestore, 'projects', scope.projectId, 'taskActivityLog');
    }
    const pid = scope.privateListId;
    return pid === 'default'
      ? collection(this.firestore, 'accounts', userId, 'taskActivityLog')
      : collection(
          this.firestore,
          'accounts',
          userId,
          'privateTaskLists',
          pid,
          'taskActivityLog',
        );
  }

  async logCreate(
    scope: TaskScope,
    payload: { taskId: string; taskTitle: string },
  ): Promise<void> {
    const uid = this.auth.userId();
    if (!uid) {
      return;
    }
    const title = payload.taskTitle.trim().slice(0, 500) || '（無題）';
    try {
      await addDoc(this.logCollectionRef(scope, uid), {
        action: 'create' satisfies TaskActivityAction,
        taskId: payload.taskId,
        taskTitle: title,
        at: serverTimestamp(),
        actorUserId: uid,
        actorDisplayName: this.auth.displayName() ?? uid,
      });
    } catch (e) {
      console.error('task activity log (create) failed:', e);
    }
  }

  async logUpdate(
    scope: TaskScope,
    payload: { taskId: string; taskTitle: string },
  ): Promise<void> {
    const uid = this.auth.userId();
    if (!uid) {
      return;
    }
    const title = payload.taskTitle.trim().slice(0, 500) || '（無題）';
    try {
      await addDoc(this.logCollectionRef(scope, uid), {
        action: 'update' satisfies TaskActivityAction,
        taskId: payload.taskId,
        taskTitle: title,
        at: serverTimestamp(),
        actorUserId: uid,
        actorDisplayName: this.auth.displayName() ?? uid,
      });
    } catch (e) {
      console.error('task activity log (update) failed:', e);
    }
  }

  async logDelete(
    scope: TaskScope,
    payload: { taskId: string; taskTitle: string },
  ): Promise<void> {
    const uid = this.auth.userId();
    if (!uid) {
      return;
    }
    const title = payload.taskTitle.trim().slice(0, 500) || '（無題）';
    try {
      await addDoc(this.logCollectionRef(scope, uid), {
        action: 'delete' satisfies TaskActivityAction,
        taskId: payload.taskId,
        taskTitle: title,
        at: serverTimestamp(),
        actorUserId: uid,
        actorDisplayName: this.auth.displayName() ?? uid,
      });
    } catch (e) {
      console.error('task activity log (delete) failed:', e);
    }
  }
}
