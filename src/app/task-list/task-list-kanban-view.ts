import { Component, inject, Input, Output, EventEmitter } from '@angular/core';
import { nextTaskStatus} from '../../models/task-status';
import { DEFAULT_KANBAN_COLUMNS, type KanbanColumn } from '../../models/kanban-column';
import { Task } from '../../models/task';
import { CdkDragDrop, moveItemInArray, DragDropModule} from '@angular/cdk/drag-drop';
import { writeBatch } from '@angular/fire/firestore';
import { doc, setDoc, Firestore, updateDoc, DocumentReference } from '@angular/fire/firestore';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatMenuModule } from '@angular/material/menu';
import { saveTaskShellScrollPosition } from '../task-shell-scroll';
import { taskDetailScopeParam, type TaskScope } from '../task-scope';
import { taskStatusTransitionPatch } from '../task-firestore-mutation';
import { TaskListDataService } from './task-list-data.service';
import { TaskActivityLogService } from '../task-activity-log.service';
import { AuthService } from '../auth.service';
import { insertionIndexInRestForMulti, insertIndexInColumnAfterRemovingBlock } from './task-list-reorder.utils';
import { Router } from '@angular/router';

@Component({
  selector: 'app-task-list-kanban-view',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatCheckboxModule, MatMenuModule, DragDropModule],
  templateUrl: './task-list-kanban-view.html',
  styleUrl: './task-list.css',
})

export class TaskListKanbanView{
    @Input() taskScope: TaskScope = { kind: 'private', privateListId: 'default' };
    @Input() kanbanColumnList: KanbanColumn[] = [...DEFAULT_KANBAN_COLUMNS];
    @Input() taskDocRef: (taskId: string) => DocumentReference | null = () => null;
    @Output() openTaskContextMenu = new EventEmitter<{ ev: MouseEvent, task: Task }>();
    @Output() openSubtaskDialog: EventEmitter<Task> = new EventEmitter<Task>();

    private readonly auth = inject(AuthService);
    private readonly firestore = inject(Firestore);
    readonly DataService = inject(TaskListDataService);
    private readonly taskActivityLog = inject(TaskActivityLogService);
    private readonly router = inject(Router);
    kanbanEditColumn: KanbanColumn | null = null;

    /** カンバン展開：同一親の子（カンバン順のみ） */
    subtasksForParentKanban(parentId: string): Task[] {
        return this.DataService.subtasksForParentKanban(parentId);
    }

    /** カンバンに表示中のカード（全列のルート＋展開中の子）の ID */
    kanbanSelectableTaskIds(): string[] {
        return this.DataService.kanbanBulkSelectableTaskIds(this.kanbanColumnList);
    }

        
    /** カンバン設定ドキュメント参照 */
    private kanbanBoardDocRef(): ReturnType<typeof doc> | null {
        const uid = this.auth.userId();
        if (!uid) {
        return null;
        }
        if (this.taskScope.kind === 'project') {
        return doc(this.firestore, 'projects', this.taskScope.projectId, 'config', 'kanban');
        }
        const scopeKey =
        this.taskScope.privateListId === 'default'
            ? 'private'
            : `pl_${this.taskScope.privateListId}`;
        return doc(this.firestore, 'accounts', uid, 'config', `kanban_${scopeKey}`);
    }

    kanbanListId(columnId: string): string {
        return `kanban-${columnId}`;
    }

    /** 列同士をつなぎ、列間ドラッグで移動できるようにする */
    kanbanConnectedIds(): string[] {
        return this.kanbanColumnList.map((c) => this.kanbanListId(c.id));
    }

    private parseKanbanColumnId(containerId: string): string {
        return containerId.startsWith('kanban-') ? containerId.slice('kanban-'.length) : '';
    }

    /** タスクが属するカンバン列 ID（未設定は先頭列） */
    columnIdForTask(task: Task): string {
        return this.DataService.kanbanColumnIdForTask(task, this.kanbanColumnList);
    }

    tasksForKanbanColumnId(colId: string): Task[] {
        return this.DataService.tasksForKanbanColumnId(colId, this.kanbanColumnList);
    }

    /** カンバン内で同一親の子だけをつなぐドロップリスト ID（列リストとは接続しない） */
    kanbanSubListId(parentId: string): string {
        return `kanban-sub-${parentId}`;
    }

    private buildKanbanColumnState(): Record<string, Task[]> {
        const state: Record<string, Task[]> = {};
        for (const c of this.kanbanColumnList) {
        state[c.id] = this.tasksForKanbanColumnId(c.id);
        }
        return state;
    }

    private orderedSelectedKanbanRoots(state: Record<string, Task[]>): Task[] {
        const out: Task[] = [];
        for (const c of this.kanbanColumnList) {
        for (const t of state[c.id] ?? []) {
            const id = t.id;
            if (id && !t.parentTaskId && this.DataService.isTaskSelected(id)) {
            out.push(t);
            }
        }
        }
        return out;
    }

        /** リスト行（task-list-item）のラベル帯色と同じ */
    kanbanLabelColor(task: Task): string {
        const c = task.label?.trim();
        return c || '#e0e0e0';
    }

    /** カンバン内で同一親の子だけをつなぐドロップリストでドラッグで移動*/
    onKanbanSubtaskDrop(ev: CdkDragDrop<Task>, parentId: string): void {
        const arr = [...this.subtasksForParentKanban(parentId)];
        const prev = ev.previousIndex;
        const cur = ev.currentIndex;
        if (prev < 0 || prev >= arr.length || cur < 0 || cur > arr.length) {
        return;
        }

        const idxSel = (i: number) => {
        const id = arr[i]?.id;
        return !!id && this.DataService.isTaskSelected(id);
        };

        const selectedIndices = new Set<number>();
        for (let i = 0; i < arr.length; i++) {
        if (idxSel(i)) {
            selectedIndices.add(i);
        }
        }
        if (!selectedIndices.has(prev)) {
        selectedIndices.clear();
        selectedIndices.add(prev);
        }

        if (selectedIndices.size === 1) {
        if (prev === cur) {
            return;
        }
        const single = [...arr];
        moveItemInArray(single, prev, cur);
        void this.persistKanbanSubtaskOrder(parentId, single);
        return;
        }

        const sortedSel = [...selectedIndices].sort((a, b) => a - b);
        const block = sortedSel.map((i) => arr[i]);
        const rest = arr.filter((_, i) => !selectedIndices.has(i));
        const k = insertionIndexInRestForMulti(arr.length, selectedIndices, cur);
        const merged = [...rest.slice(0, k), ...block, ...rest.slice(k)];
        void this.persistKanbanSubtaskOrder(parentId, merged);
    }

    /** ドラッグで列間移動*/
    onKanbanDrop(ev: CdkDragDrop<Task>): void {
        const task = ev.item.data as Task | undefined;
        if (!task?.id || task.parentTaskId) {
        return;
        }
        const fromId = this.parseKanbanColumnId(ev.previousContainer.id);
        const toId = this.parseKanbanColumnId(ev.container.id);
        if (!fromId || !toId || !this.kanbanColumnList.some((c) => c.id === fromId)) {
        return;
        }
        if (!this.kanbanColumnList.some((c) => c.id === toId)) {
        return;
        }

        const state = this.buildKanbanColumnState();
        const prev = ev.previousIndex;
        const cur = ev.currentIndex;

        let block = this.orderedSelectedKanbanRoots(state);
        if (block.length === 0 || !block.some((t) => t.id === task.id)) {
        block = [task];
        }
        const blockIds = new Set<string>();
        for (const t of block) {
        if (t.id) {
            blockIds.add(t.id);
        }
        }

        if (block.length === 1) {
        if (fromId === toId) {
            const arr = [...(state[fromId] ?? [])];
            if (arr.length === 0) {
            return;
            }
            if (prev < 0 || prev >= arr.length || cur < 0 || cur > arr.length) {
            return;
            }
            if (prev === cur) {
            return;
            }
            const single = [...arr];
            moveItemInArray(single, prev, cur);
            state[fromId] = single;
            void this.persistKanbanBoardOrder(state);
            return;
        }

        const fromArr = [...(state[fromId] ?? [])];
        const toArr = [...(state[toId] ?? [])];
        if (prev < 0 || prev >= fromArr.length || cur < 0 || cur > toArr.length) {
            return;
        }
        const fa = [...fromArr];
        const ta = [...toArr];
        const [moved] = fa.splice(prev, 1);
        if (!moved) {
            return;
        }
        const updated: Task = { ...moved, kanbanColumnId: toId };
        const insertAt = Math.min(Math.max(0, cur), ta.length);
        ta.splice(insertAt, 0, updated);
        state[fromId] = fa;
        state[toId] = ta;
        void this.persistKanbanBoardOrder(state);
        return;
        }

        const origTo = [...(state[toId] ?? [])];
        if (cur < 0 || cur > origTo.length) {
        return;
        }

        for (const c of this.kanbanColumnList) {
        const cid = c.id;
        state[cid] = (state[cid] ?? []).filter((t) => !t.id || !blockIds.has(t.id));
        }

        const toAfter = [...(state[toId] ?? [])];
        const blockTouchesDest = block.some((t) => t.id && origTo.some((o) => o.id === t.id));
        const insertAt = blockTouchesDest
        ? insertIndexInColumnAfterRemovingBlock(origTo, cur, blockIds)
        : Math.min(Math.max(0, cur), toAfter.length);

        const movedBlock = block.map((t) => ({ ...t, kanbanColumnId: toId }));
        state[toId] = [...toAfter.slice(0, insertAt), ...movedBlock, ...toAfter.slice(insertAt)];
        void this.persistKanbanBoardOrder(state);
    }

    private async persistKanbanBoardOrder(state: Record<string, Task[]>): Promise<void> {
        const flat: Task[] = [];
        for (const col of this.kanbanColumnList) {
        flat.push(...(state[col.id] ?? []));
        }
        const batch = writeBatch(this.firestore);
        const firstCol = this.kanbanColumnList[0]?.id ?? null;
        flat.forEach((t, i) => {
        const id = t.id;
        if (!id) {
            return;
        }
        const r = this.taskDocRef(id);
        if (!r) {
            return;
        }
        const kid = t.kanbanColumnId ?? firstCol;
        batch.update(r, { kanbanOrderIndex: i * 1000, kanbanColumnId: kid });
        for (const ch of this.DataService.tasks()) {
            if (ch.parentTaskId === id && ch.id) {
            const r2 = this.taskDocRef(ch.id);
            if (r2) {
                batch.update(r2, { kanbanColumnId: kid });
            }
            }
        }
        });
        try {
        this.DataService.clearTaskSelection();
        await batch.commit();
        } catch (e) {
        console.error('persistKanbanBoardOrder failed:', e);
        }
    }

    async renameKanbanColumn(col: KanbanColumn): Promise<void> {
        const n = window.prompt('リスト名', col.title);
        if (n === null) {
        return;
        }
        const title = n.trim() || '（無題）';
        const ref = this.kanbanBoardDocRef();
        if (!ref) {
        return;
        }
        const next = this.kanbanColumnList.map((c) =>
        c.id === col.id ? { ...c, title } : c,
        );
        try {
        await setDoc(ref, { columns: next }, { merge: true });
        await this.taskActivityLog.logKanbanUpdate(this.taskScope, {
            subjectId: col.id,
            subjectTitle: title,
        });
        } catch (e) {
        alert(e instanceof Error ? e.message : '更新に失敗しました');
        }
    }

    async deleteKanbanColumn(col: KanbanColumn): Promise<void> {
        if (this.kanbanColumnList.length <= 1) {
        alert('最後の1列は削除できません。');
        return;
        }
        if (
        !confirm(
            `「${col.title}」を削除しますか？\nこの列のタスクは他の列へ移動します。`,
        )
        ) {
        return;
        }
        const ref = this.kanbanBoardDocRef();
        if (!ref) {
        return;
        }
        const idx = this.kanbanColumnList.findIndex((c) => c.id === col.id);
        if (idx < 0) {
        return;
        }
        const fallbackId =
        idx === 0 ? this.kanbanColumnList[1].id : this.kanbanColumnList[0].id;
        const nextCols = this.kanbanColumnList.filter((c) => c.id !== col.id);
        const affected = this.DataService.tasks().filter((t) => {
        const cid = this.columnIdForTask(t);
        return cid === col.id;
        });
        try {
        await this.taskActivityLog.logKanbanDelete(this.taskScope, {
            subjectId: col.id,
            subjectTitle: col.title,
        });
        const batch = writeBatch(this.firestore);
        for (const t of affected) {
            const tid = t.id;
            if (!tid) {
            continue;
            }
            const r = this.taskDocRef(tid);
            if (r) {
            batch.update(r, { kanbanColumnId: fallbackId });
            }
        }
        await batch.commit();
        await setDoc(ref, { columns: nextCols }, { merge: true });
        } catch (e) {
        alert(e instanceof Error ? e.message : '削除に失敗しました');
        }
    }

    async addKanbanColumn(): Promise<void> {
        const ref = this.kanbanBoardDocRef();
        if (!ref) {
        return;
        }
        const id = `kb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
        const title = `リスト ${this.kanbanColumnList.length + 1}`;
        const next = [...this.kanbanColumnList, { id, title }];
        try {
        await setDoc(ref, { columns: next }, { merge: true });
        await this.taskActivityLog.logKanbanCreate(this.taskScope, {
            subjectId: id,
            subjectTitle: title,
        });
        } catch (e) {
        alert(e instanceof Error ? e.message : '追加に失敗しました');
        }
    }

    onKanbanSubtasksToggleClick(ev: MouseEvent, task: Task): void {
        ev.preventDefault();
        ev.stopPropagation();
        const id = task.id;
        if (!id) {
        return;
        }
        if (this.DataService.hasChildTasks(id)) {
        this.DataService.toggleSubtasksExpanded(id);
        } else {
        this.openSubtaskDialog.emit(task);
        }
    }

    onKanbanCardClick(ev: MouseEvent, task: Task): void {
        const el = ev.target as HTMLElement | null;
        if (!el || el.closest('button') || el.closest('.kanban-label-strip')) {
        return;
        }
        ev.preventDefault();
        const id = task.id;
        if (!id) {
        return;
        }
        const prev = task.status;
        const next = nextTaskStatus(prev);
        const ref = this.taskDocRef(id);
        if (!ref) {
        return;
        }
        void updateDoc(ref, taskStatusTransitionPatch(next, prev))
        .then(() =>
            this.taskActivityLog.logUpdate(this.taskScope, {
            subjectId: id,
            subjectTitle: task.title,
            }),
        )
        .catch((err) => console.error('kanban status update failed:', err));
    }

    openKanbanDetail(ev: Event, task: Task): void {
        ev.preventDefault();
        ev.stopPropagation();
        const id = task.id;
        if (!id) {
        return;
        }
        saveTaskShellScrollPosition();
        void this.router.navigate(['/task', taskDetailScopeParam(this.taskScope), id], {
        queryParams: { from: 'kanban' },
        });
    }

        
    private async persistKanbanSubtaskOrder(parentId: string, ordered: Task[]): Promise<void> {
        const batch = writeBatch(this.firestore);
        ordered.forEach((task, index) => {
        const id = task.id;
        if (!id) {
            return;
        }
        if (task.parentTaskId !== parentId) {
            return;
        }
        const r = this.taskDocRef(id);
        if (!r) {
            return;
        }
        batch.update(r, { kanbanOrderIndex: index * 1000 });
        });
        try {
        await batch.commit();
        } catch (e) {
        console.error('persistKanbanSubtaskOrder failed:', e);
        }
    }

}

