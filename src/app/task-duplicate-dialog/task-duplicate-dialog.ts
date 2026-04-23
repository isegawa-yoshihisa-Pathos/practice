import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import {
  Firestore,
  collection,
  addDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  Timestamp,
  serverTimestamp,
} from '@angular/fire/firestore';
import { AuthService } from '../auth.service';
import { TaskScope } from '../task-scope';
import type { Task } from '../../models/task';
import { firestoreStatusFields } from '../../models/task-status';
import { clampTaskPriority } from '../task-priority';
import { DEFAULT_KANBAN_COLUMNS, type KanbanColumn } from '../../models/kanban-column';
import { TaskActivityLogService } from '../task-activity-log.service';
import { TaskCollectionReferenceService } from '../task-collection-reference.service';
import { timestampLikeToDate } from '../task-schedule';

export interface TaskDuplicateDialogData {
  tasks: Task[];
  taskScope: TaskScope;
}

export type DuplicateDestinationRow = {
  key: string;
  label: string;
  scope: TaskScope;
};

@Component({
  selector: 'app-task-duplicate-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule, MatDialogModule, MatButtonModule, MatCheckboxModule],
  templateUrl: './task-duplicate-dialog.html',
  styleUrl: './task-duplicate-dialog.css',
})
export class TaskDuplicateDialog {
  private readonly dialogRef = inject(MatDialogRef<TaskDuplicateDialog>);
  private readonly firestore = inject(Firestore);
  private readonly auth = inject(AuthService);
  private readonly taskActivityLog = inject(TaskActivityLogService);
  private readonly taskCollectionRef = inject(TaskCollectionReferenceService);
  readonly data = inject<TaskDuplicateDialogData>(MAT_DIALOG_DATA);

  loading = true;
  loadError: string | null = null;
  destinations: DuplicateDestinationRow[] = [];
  selectedKeys = new Set<string>();
  saving = false;
  saveError: string | null = null;

  constructor() {
    void this.loadDestinations();
  }

  private kanbanConfigDocRef(uid: string, scope: TaskScope) {
    if (scope.kind === 'project') {
      return doc(this.firestore, 'projects', scope.projectId, 'config', 'kanban');
    }
    const scopeKey =
      scope.privateListId === 'default' ? 'private' : `pl_${scope.privateListId}`;
    return doc(this.firestore, 'accounts', uid, 'config', `kanban_${scopeKey}`);
  }

  private async normalizeKanbanColumns(raw: unknown): Promise<KanbanColumn[]> {
    if (!Array.isArray(raw) || raw.length === 0) {
      return [...DEFAULT_KANBAN_COLUMNS];
    }
    const out: KanbanColumn[] = [];
    for (const x of raw) {
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        const id = typeof o['id'] === 'string' ? o['id'].trim() : '';
        const title = typeof o['title'] === 'string' ? o['title'].trim() : '';
        if (id) {
          out.push({ id, title: title || '（無題）' });
        }
      }
    }
    return out.length > 0 ? out : [...DEFAULT_KANBAN_COLUMNS];
  }

  private async getFirstKanbanColumnId(uid: string, scope: TaskScope): Promise<string> {
    const ref = this.kanbanConfigDocRef(uid, scope);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, { columns: [...DEFAULT_KANBAN_COLUMNS] }, { merge: true });
      return DEFAULT_KANBAN_COLUMNS[0].id;
    }
    const cols = await this.normalizeKanbanColumns(snap.data()?.['columns']);
    return cols[0]?.id ?? DEFAULT_KANBAN_COLUMNS[0].id;
  }

  private async loadDestinations(): Promise<void> {
    this.loading = true;
    this.loadError = null;
    const uid = this.auth.userId();
    if (!uid) {
      this.loadError = 'ログインが必要です';
      this.loading = false;
      return;
    }
    try {
      const rows: DuplicateDestinationRow[] = [];
      const uiSnap = await getDoc(doc(this.firestore, 'accounts', uid, 'config', 'privateUi'));
      const defaultLabel =
        uiSnap.exists() &&
        typeof (uiSnap.data() as Record<string, unknown>)['defaultListLabel'] === 'string'
          ? String((uiSnap.data() as Record<string, unknown>)['defaultListLabel']).trim() ||
            'プライベート'
          : 'プライベート';
      rows.push({
        key: 'private:default',
        label: defaultLabel,
        scope: { kind: 'private', privateListId: 'default' },
      });

      const plSnap = await getDocs(
        collection(this.firestore, 'accounts', uid, 'privateTaskLists'),
      );
      plSnap.forEach((d) => {
        const t = d.data() as Record<string, unknown>;
        const title =
          typeof t['title'] === 'string' && t['title'].trim() !== ''
            ? t['title'].trim()
            : '（無題）';
        rows.push({
          key: `private:${d.id}`,
          label: title,
          scope: { kind: 'private', privateListId: d.id },
        });
      });

      const memSnap = await getDocs(
        collection(this.firestore, 'accounts', uid, 'projectMemberships'),
      );
      memSnap.forEach((d) => {
        const data = d.data() as Record<string, unknown>;
        const name =
          typeof data['projectName'] === 'string' && data['projectName'].trim() !== ''
            ? data['projectName'].trim()
            : '（無題）';
        rows.push({
          key: `project:${d.id}`,
          label: name,
          scope: { kind: 'project', projectId: d.id },
        });
      });

      rows.sort((a, b) => a.label.localeCompare(b.label, 'ja'));
      this.destinations = rows;
    } catch (e) {
      this.loadError = e instanceof Error ? e.message : '一覧の取得に失敗しました';
    } finally {
      this.loading = false;
    }
  }

  toggleDest(key: string, checked: boolean): void {
    const next = new Set(this.selectedKeys);
    if (checked) {
      next.add(key);
    } else {
      next.delete(key);
    }
    this.selectedKeys = next;
  }

  isSelected(key: string): boolean {
    return this.selectedKeys.has(key);
  }

  cancel(): void {
    this.dialogRef.close();
  }

  async complete(): Promise<void> {
    if (this.selectedKeys.size === 0) {
      this.saveError = '複製先を1つ以上選んでください';
      return;
    }
    this.saveError = null;
    this.saving = true;
    const uid = this.auth.userId();
    if (!uid) {
      this.saveError = 'ログインが必要です';
      this.saving = false;
      return;
    }
    try {
      const sorted = this.topologicallySortedTasks(this.data.tasks);
      for (const key of this.selectedKeys) {
        const row = this.destinations.find((d) => d.key === key);
        if (!row) {
          continue;
        }
        await this.duplicateTasksToScope(uid, sorted, this.data.taskScope, row.scope);
      }
      this.dialogRef.close(true);
    } catch (e) {
      this.saveError = e instanceof Error ? e.message : '複製に失敗しました';
    } finally {
      this.saving = false;
    }
  }

  private topologicallySortedTasks(tasks: Task[]): Task[] {
    const byId = new Map(tasks.map((t) => [t.id!, t]));
    const ids = new Set(tasks.map((t) => t.id!).filter(Boolean));
    const result: Task[] = [];
    const visiting = new Set<string>();

    const visit = (id: string) => {
      if (!ids.has(id)) {
        return;
      }
      if (result.some((t) => t.id === id)) {
        return;
      }
      if (visiting.has(id)) {
        return;
      }
      visiting.add(id);
      const t = byId.get(id);
      if (t?.parentTaskId && ids.has(t.parentTaskId)) {
        visit(t.parentTaskId);
      }
      visiting.delete(id);
      if (t) {
        result.push(t);
      }
    };

    for (const id of ids) {
      visit(id);
    }
    return result;
  }

  private async loadProjectMemberIds(projectId: string): Promise<Set<string>> {
    const snap = await getDocs(
      collection(this.firestore, 'projects', projectId, 'members'),
    );
    const s = new Set<string>();
    snap.forEach((d) => s.add(d.id));
    return s;
  }

  private resolveAssignee(
    src: TaskScope,
    dest: TaskScope,
    assignee: string | null | undefined,
    destMemberIds: Set<string>,
  ): string | null {
    const a = assignee?.trim() || null;
    if (dest.kind === 'private') {
      if (src.kind === 'project') {
        return null;
      }
      return a;
    }
    if (src.kind === 'private') {
      return null;
    }
    if (a && destMemberIds.has(a)) {
      return a;
    }
    return null;
  }

  private async duplicateTasksToScope(
    uid: string,
    tasks: Task[],
    sourceScope: TaskScope,
    destScope: TaskScope,
  ): Promise<void> {
    const destCol = this.taskCollectionRef.tasksCollectionRef(uid, destScope);
    if (!destCol) return;
    const existingSnap = await getDocs(destCol);

    type Shadow = {
      id: string;
      parentTaskId: string | null;
      listOrderIndex?: number;
      kanbanOrderIndex?: number;
      kanbanColumnId?: string | null;
    };
    const working: Shadow[] = existingSnap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>;
      const parentTaskId =
        typeof data['parentTaskId'] === 'string' && data['parentTaskId'].trim() !== ''
          ? data['parentTaskId'].trim()
          : null;
      const rawLo = data['listOrderIndex'];
      const listOrderIndex =
        typeof rawLo === 'number' && !Number.isNaN(rawLo) ? rawLo : undefined;
      const rawKo = data['kanbanOrderIndex'];
      const kanbanOrderIndex =
        typeof rawKo === 'number' && !Number.isNaN(rawKo) ? rawKo : undefined;
      const rawKb = data['kanbanColumnId'];
      const kanbanColumnId =
        typeof rawKb === 'string' && rawKb.trim() !== '' ? rawKb.trim() : null;
      return {
        id: d.id,
        parentTaskId,
        listOrderIndex,
        kanbanOrderIndex,
        kanbanColumnId,
      };
    });

    const destMemberIds =
      destScope.kind === 'project'
        ? await this.loadProjectMemberIds(destScope.projectId)
        : new Set<string>();

    const firstKanbanId = await this.getFirstKanbanColumnId(uid, destScope);

    const idMap = new Map<string, string>();

    const maxRootOrder = (): number => {
      let m = -1;
      for (const w of working.filter((x) => !x.parentTaskId)) {
        if (typeof w.listOrderIndex === 'number' && !Number.isNaN(w.listOrderIndex)) {
          m = Math.max(m, w.listOrderIndex);
        }
      }
      return m;
    };

    const maxChildOrder = (parentId: string): number => {
      let m = -1;
      for (const w of working.filter((x) => x.parentTaskId === parentId)) {
        if (typeof w.listOrderIndex === 'number' && !Number.isNaN(w.listOrderIndex)) {
          m = Math.max(m, w.listOrderIndex);
        }
      }
      return m;
    };

    const maxKanbanInColumn = (colId: string, parentId: string | null): number => {
      let m = -1;
      for (const w of working) {
        const wCol = w.kanbanColumnId || colId;
        if (wCol !== colId) {
          continue;
        }
        if (!parentId) {
          if (w.parentTaskId) {
            continue;
          }
        } else if (w.parentTaskId !== parentId) {
          continue;
        }
        if (typeof w.kanbanOrderIndex === 'number' && !Number.isNaN(w.kanbanOrderIndex)) {
          m = Math.max(m, w.kanbanOrderIndex);
        }
      }
      return m;
    };

    for (const src of tasks) {
      const oid = src.id;
      if (!oid) {
        continue;
      }

      const assignee = this.resolveAssignee(
        sourceScope,
        destScope,
        src.assignee ?? null,
        destMemberIds,
      );

      let newParent: string | null = null;
      if (src.parentTaskId && idMap.has(src.parentTaskId)) {
        newParent = idMap.get(src.parentTaskId)!;
      }

      const colId = newParent
        ? working.find((w) => w.id === newParent)?.kanbanColumnId || firstKanbanId
        : firstKanbanId;

      let listOrderIndex: number;
      if (!newParent) {
        const base = maxRootOrder();
        listOrderIndex = (base < 0 ? 0 : base) + 1000;
      } else {
        const base = maxChildOrder(newParent);
        listOrderIndex = (base < 0 ? 0 : base) + 1000;
      }

      const kbBase = maxKanbanInColumn(colId, newParent);
      const kanbanOrderIndex = (kbBase < 0 ? 0 : kbBase) + 1000;

      const payload = this.buildPayload(
        src,
        sourceScope,
        destScope,
        assignee,
        newParent,
        listOrderIndex,
        kanbanOrderIndex,
        colId,
      );

      const ref = await addDoc(destCol, payload);
      idMap.set(oid, ref.id);

      working.push({
        id: ref.id,
        parentTaskId: newParent,
        listOrderIndex,
        kanbanOrderIndex,
        kanbanColumnId: colId,
      });

      await this.taskActivityLog.logCreate(destScope, {
        subjectId: ref.id,
        subjectTitle: src.title || '（無題）',
      });
    }
  }

  private buildPayload(
    src: Task,
    sourceScope: TaskScope,
    destScope: TaskScope,
    assignee: string | null,
    parentTaskId: string | null,
    listOrderIndex: number,
    kanbanOrderIndex: number,
    kanbanColumnId: string,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      title: src.title ?? '',
      label: (src.label ?? '').trim() || '#e0e0e0',
      ...firestoreStatusFields(src.status),
      priority: clampTaskPriority(src.priority),
      description: typeof src.description === 'string' ? src.description : '',
      parentTaskId: parentTaskId || null,
      listOrderIndex,
      kanbanOrderIndex,
      kanbanColumnId,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (src.deadline) {
      const d = timestampLikeToDate(src.deadline);
      if (d) {
        payload['deadline'] = Timestamp.fromDate(d);
        payload['startAt'] = null;
        payload['endAt'] = null;
      }
    } else if (src.startAt && src.endAt) {
      const s = timestampLikeToDate(src.startAt);
      const e = timestampLikeToDate(src.endAt);
      if (s && e) {
        payload['deadline'] = null;
        payload['startAt'] = Timestamp.fromDate(s);
        payload['endAt'] = Timestamp.fromDate(e);
      }
    } else {
      payload['deadline'] = null;
      payload['startAt'] = null;
      payload['endAt'] = null;
    }

    if (destScope.kind === 'project') {
      payload['assignee'] = assignee || null;
    } else if (sourceScope.kind !== 'project' && assignee) {
      payload['assignee'] = assignee;
    }

    if (src.status === 'done') {
      payload['completedAt'] = serverTimestamp();
    }

    return payload;
  }
}
