import { Injectable, signal, computed, effect } from '@angular/core';
import {
  collectionData,
  onSnapshot,
  query,
  where,
  orderBy,
  Unsubscribe,
  Query,
  DocumentData,
} from '@angular/fire/firestore';
import { Subscription, map } from 'rxjs';
import { Task } from '../../models/task';
import type { KanbanColumn } from '../../models/kanban-column';
import { mapFirestoreDocToTask } from '../task-firestore-mutation';
import {
  TaskFilterState,
  defaultTaskFilterState,
  filterTasks,
} from '../task-filter';
import { TaskSortField, sortTasks } from '../task-sort';

export type TaskListSortKeys = {
  f1: TaskSortField | null;
  f2: TaskSortField | null;
  f3: TaskSortField | null;
  asc: boolean;
};

function listOrderNum(t: Task): number {
  const v = t.listOrderIndex;
  return typeof v === 'number' && !Number.isNaN(v) ? v : Number.MAX_SAFE_INTEGER;
}

function kanbanOrderNum(t: Task): number {
  const v = t.kanbanOrderIndex;
  return typeof v === 'number' && !Number.isNaN(v) ? v : Number.MAX_SAFE_INTEGER;
}

@Injectable()
export class TaskListDataService {
  private _tasks = signal<Task[]>([]);
  readonly tasks = this._tasks.asReadonly();

  selectedTaskIdSet = signal<Set<string>>(new Set());

  private rootSubscription?: Subscription;
  private subTaskUnsubscribers = new Map<string, Unsubscribe>();
  private currentCollectionRef: any;

  /** プロジェクト一覧かどうか（filterTasks の担当者フィルタ等に使用） */
  readonly isProjectScope = signal(false);

  filterState = signal<TaskFilterState>(defaultTaskFilterState());

  sortKeys = signal<TaskListSortKeys>({
    f1: null,
    f2: null,
    f3: null,
    asc: true,
  });

  filteredTasks = computed(() => {
    const now = new Date();
    return filterTasks(
      this._tasks(),
      this.filterState(),
      now,
      this.isProjectScope(),
    );
  });

  displayRootTasks = computed(() => {
    const allFiltered = this.filteredTasks();
    const roots = allFiltered.filter((t) => !t.parentTaskId);
    const s = this.sortKeys();
    const keys = [s.f1, s.f2, s.f3].filter(
      (k): k is TaskSortField => k !== null,
    );
    if (keys.length === 0) {
      return [...roots].sort((a, b) => {
        const oa = listOrderNum(a);
        const ob = listOrderNum(b);
        if (oa !== ob) {
          return oa - ob;
        }
        return (a.title ?? '').localeCompare(b.title ?? '');
      });
    }
    return sortTasks(roots, keys, s.asc);
  });

  expandedTaskIds = signal<Set<string>>(new Set());

  constructor() {
    effect(() => {
      const ids = this.expandedTaskIds();
      if (!this.currentCollectionRef) return;

      ids.forEach((id) => {
        if (!this.subTaskUnsubscribers.has(id)) {
          this.subscribeSubtasks(id, this.currentCollectionRef);
        }
      });

      this.subTaskUnsubscribers.forEach((unsub, id) => {
        if (!ids.has(id)) {
          unsub();
          this.subTaskUnsubscribers.delete(id);
          this._tasks.update((tasks) =>
            tasks.filter((t) => t.parentTaskId !== id),
          );
        }
      });
    });
  }

  /** 親が子を持つ（フィルタ後に1件以上） */
  hasChildTasks(parentId: string | undefined): boolean {
    if (!parentId) return false;

    const parentTask = this.tasks().find(t => t.id === parentId);
    return !!(parentTask && (parentTask.childTaskCount ?? 0) > 0);
  }

  toggleSubtasksExpanded(parentId: string): void {
    const current = this.expandedTaskIds();
    const next = new Set(current);
    if (next.has(parentId)) {
      next.delete(parentId);
    } else {
      next.add(parentId);
    }
    this.expandedTaskIds.set(next);
  }

  isSubtasksExpanded(parentId: string | undefined): boolean {
    return !!parentId && this.expandedTaskIds().has(parentId);
  }

  /** リスト展開：同一親の子（リスト順のみ） */
  subtasksForParentInListOrder(parentId: string): Task[] {
    return this.filteredTasks()
      .filter((t) => t.parentTaskId === parentId)
      .sort((a, b) => {
        const c = listOrderNum(a) - listOrderNum(b);
        if (c !== 0) {
          return c;
        }
        return (a.title ?? '').localeCompare(b.title ?? '');
      });
  }

  /** リストに表示中の行（ルート＋展開中の子）の ID — 親テンプレの一括チェックは子 ViewChild より先に評価されるため DataService 側で算出する */
  listBulkSelectableTaskIds(): string[] {
    const ids: string[] = [];
    for (const t of this.displayRootTasks()) {
      if (t.id) {
        ids.push(t.id);
      }
      const pid = t.id;
      if (pid && this.isSubtasksExpanded(pid)) {
        for (const st of this.subtasksForParentInListOrder(pid)) {
          if (st.id) {
            ids.push(st.id);
          }
        }
      }
    }
    return ids;
  }

  /** タスクが属するカンバン列 ID（未設定は先頭列） */
  kanbanColumnIdForTask(task: Task, kanbanColumnList: KanbanColumn[]): string {
    const first = kanbanColumnList[0]?.id ?? '';
    const k =
      typeof task.kanbanColumnId === 'string' ? task.kanbanColumnId.trim() : '';
    if (k && kanbanColumnList.some((c) => c.id === k)) {
      return k;
    }
    return first;
  }

  tasksForKanbanColumnId(
    colId: string,
    kanbanColumnList: KanbanColumn[],
  ): Task[] {
    const filtered = this.filteredTasks().filter((t) => !t.parentTaskId);
    const inCol = filtered.filter(
      (t) => this.kanbanColumnIdForTask(t, kanbanColumnList) === colId,
    );
    return [...inCol].sort((a, b) => {
      const c = kanbanOrderNum(a) - kanbanOrderNum(b);
      if (c !== 0) {
        return c;
      }
      return (a.title ?? '').localeCompare(b.title ?? '');
    });
  }

  /** カンバン展開：同一親の子（カンバン順のみ） */
  subtasksForParentKanban(parentId: string): Task[] {
    const filtered = this.filteredTasks().filter(
      (t) => t.parentTaskId === parentId,
    );
    return [...filtered].sort((a, b) => {
      const c = kanbanOrderNum(a) - kanbanOrderNum(b);
      if (c !== 0) {
        return c;
      }
      return (a.title ?? '').localeCompare(b.title ?? '');
    });
  }

  /** カンバンに表示中のカード（全列のルート＋展開中の子）の ID */
  kanbanBulkSelectableTaskIds(kanbanColumnList: KanbanColumn[]): string[] {
    if (!kanbanColumnList.length) {
      return [];
    }
    const ids: string[] = [];
    for (const col of kanbanColumnList) {
      for (const t of this.tasksForKanbanColumnId(col.id, kanbanColumnList)) {
        if (t.id) {
          ids.push(t.id);
        }
        const pid = t.id;
        if (pid && this.isSubtasksExpanded(pid)) {
          for (const st of this.subtasksForParentKanban(pid)) {
            if (st.id) {
              ids.push(st.id);
            }
          }
        }
      }
    }
    return ids;
  }

  setProjectScope(isProject: boolean): void {
    this.isProjectScope.set(isProject);
  }

  patchFilter(partial: Partial<TaskFilterState>): void {
    this.filterState.update((s) => ({ ...s, ...partial }));
  }

  resetFilters(): void {
    this.filterState.set(defaultTaskFilterState());
  }

  patchSortKeys(partial: Partial<TaskListSortKeys>): void {
    this.sortKeys.update((s) => ({ ...s, ...partial }));
  }

  isTaskSelected(taskId: string | undefined): boolean {
    return !!taskId && this.selectedTaskIdSet().has(taskId);
  }

  /**　親タスクの選択を変更すると子タスクの選択も変更される */
  onTaskSelectionChange(task: Task, selected: boolean): void {
    const id = task.id;
    if (!id) {
      return;
    }
    const subtree = this.collectSubtreeIds(id);
    const next = new Set(this.selectedTaskIdSet());
    if (selected) {
      for (const x of subtree) {
        next.add(x);
      }
    } else {
      for (const x of subtree) {
        next.delete(x);
      }
    }
    this.selectedTaskIdSet.set(next);
  }

  clearTaskSelection(): void {
    this.selectedTaskIdSet.set(new Set());
  }

  selectAllTasks(checked: boolean, selectableTaskIds: string[]): void {
    if (checked) {
      const next = new Set(this.selectedTaskIdSet());
      for (const id of selectableTaskIds) {
        next.add(id);
      }
      this.selectedTaskIdSet.set(next);
    } else {
      this.clearTaskSelection();
    }
  }

  private collectSubtreeIds(rootId: string): Set<string> {
    const out = new Set<string>();
    const walk = (pid: string) => {
      out.add(pid);
      for (const x of this.tasks()) {
        if (x.parentTaskId === pid && x.id) {
          walk(x.id);
        }
      }
    };
    walk(rootId);
    return out;
  }

  /**
   * スコープ（プロジェクトやマイリスト）が切り替わった際の初期化
   */
  initForScope(collectionRef: any) {
    this.destroy();
    this.currentCollectionRef = collectionRef;

    const q = query(
      collectionRef,
      where('parentTaskId', '==', null),
      orderBy('listOrderIndex', 'asc'),
    );

    this.rootSubscription = collectionData<DocumentData, 'id'>(
      q as Query<DocumentData>,
      { idField: 'id' },
    )
      .pipe(
        map((rows) =>
          rows.map((row) =>
            mapFirestoreDocToTask(row as Record<string, unknown>),
          ),
        ),
      )
      .subscribe({
        next: (newRootTasks) => {
          this.mergeRootTasks(newRootTasks);
        },
        error: (error) => {
          console.error('mergeRootTasks error:', error);
        },
      });
  }

  private mergeRootTasks(newRoots: Task[]) {
    const newRootIds = new Set(
      newRoots
        .map((t) => t.id)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    );
    const preservedSubs = this._tasks().filter((t) => {
      return (
        !!t.parentTaskId &&
        this.subTaskUnsubscribers.has(t.parentTaskId) &&
        newRootIds.has(t.parentTaskId)
      );
    });
    this._tasks.set([...newRoots, ...preservedSubs]);
  }

  subscribeSubtasks(parentId: string, collectionRef: any) {
    if (this.subTaskUnsubscribers.has(parentId)) return;

    const q = query(
      collectionRef,
      where('parentTaskId', '==', parentId),
      orderBy('listOrderIndex', 'asc'),
    );

    const unsub = onSnapshot(q, (snapshot) => {
      let newTasks = [...this._tasks()];

      snapshot.docChanges().forEach((change) => {
        const raw: Record<string, unknown> = {
          id: change.doc.id,
          ...(change.doc.data() as Record<string, unknown>),
        };
        const id = change.doc.id;

        if (change.type === 'added' || change.type === 'modified') {
          const data = mapFirestoreDocToTask(raw);
          const index = newTasks.findIndex((t) => t.id === id);
          if (index > -1) {
            newTasks[index] = data;
          } else {
            newTasks.push(data);
          }
        } else if (change.type === 'removed') {
          newTasks = newTasks.filter((t) => t.id !== id);
        }
      });

      this._tasks.set(newTasks);
    });

    this.subTaskUnsubscribers.set(parentId, unsub);
  }

  unsubscribeSubtasks(parentId: string) {
    const unsub = this.subTaskUnsubscribers.get(parentId);
    if (unsub) {
      unsub();
      this.subTaskUnsubscribers.delete(parentId);
    }
  }

  setTasks(newTasks: Task[]) {
    this._tasks.set(newTasks);
  }

  destroy() {
    if (this.rootSubscription) {
      this.rootSubscription.unsubscribe();
      this.rootSubscription = undefined;
    }
    this.subTaskUnsubscribers.forEach((unsub) => unsub());
    this.subTaskUnsubscribers.clear();
    this._tasks.set([]);
    this.expandedTaskIds.set(new Set());
    this.currentCollectionRef = null;
    this.clearTaskSelection();
  }
}
