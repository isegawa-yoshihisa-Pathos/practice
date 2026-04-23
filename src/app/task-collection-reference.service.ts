import { inject, Injectable } from '@angular/core';
import { Firestore, collection } from "@angular/fire/firestore";
import type { TaskScope } from "./task-scope";

@Injectable({
  providedIn: 'root',
})

export class TaskCollectionReferenceService {
  private readonly firestore = inject(Firestore);

  tasksCollectionRef(userId: string | null, scope: TaskScope) {
      if (!userId) return null;
      if (scope.kind === 'project') {
          return collection(this.firestore, 'projects', scope.projectId, 'tasks');
      }
      const pid = scope.privateListId;
      return pid === 'default'
      ? collection(this.firestore, 'accounts', userId, 'tasks')
      : collection(
        this.firestore,
        'accounts',
        userId,
        'privateTaskLists',
        pid,
        'tasks',
      );
  }
}
