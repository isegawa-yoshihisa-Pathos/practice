import { Component, inject, Input, Output, EventEmitter } from '@angular/core';
import { CdkDragDrop, moveItemInArray } from '@angular/cdk/drag-drop';
import { Task } from '../../models/task';
import { type TaskScope } from '../task-scope';
import { ProjectMemberRow } from '../../models/project-member';
import { DocumentReference } from '@angular/fire/firestore';
import { TaskListDataService } from './task-list-data.service';
import { Firestore, writeBatch } from '@angular/fire/firestore';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { TaskListItem } from '../task-list-item/task-list-item';
import { CommonModule } from '@angular/common';
import { DragDropModule } from '@angular/cdk/drag-drop';
import { insertionIndexInRestForMulti } from './task-list-reorder.utils';
import { isFilterDefaultForReorder } from '../task-filter';

@Component({
  selector: 'app-task-list-list-view',
  standalone: true,
  imports: [CommonModule, DragDropModule, MatCheckboxModule, TaskListItem],
  templateUrl: './task-list-list-view.html',
  styleUrl: './task-list.css',
})

export class TaskListListView{  
    @Input() taskScope: TaskScope = { kind: 'private', privateListId: 'default' };
    @Input() projectMembers: ProjectMemberRow[] = [];
    @Input() taskDocRef: (taskId: string) => DocumentReference | null = () => null;
    @Output() openSubtaskDialog = new EventEmitter<Task>();
    @Output() contextMenuRequest = new EventEmitter<{ ev: MouseEvent; task: Task }>();
    @Output() deleteRequested = new EventEmitter<Task>();
    readonly DataService = inject(TaskListDataService);
    private readonly firestore = inject(Firestore);
    /** リスト用の並びキー */
    private listOrderNum(t: Task): number {
        const v = t.listOrderIndex;
        return typeof v === 'number' && !Number.isNaN(v) ? v : Number.MAX_SAFE_INTEGER;
    }

    /** リスト展開：同一親の子（リスト順のみ） */
    subtasksForParentList(parentId: string): Task[] {
        return this.DataService
        .filteredTasks()
        .filter((t) => t.parentTaskId === parentId)
        .sort((a, b) => {
        const c = this.listOrderNum(a) - this.listOrderNum(b);
        if (c !== 0) {
            return c;
        }
        return (a.title ?? '').localeCompare(b.title ?? '');
        });
    }

    /** 親の `onSubtasksToggleForListItem` と同じ（子タスク一覧の購読は DataService 側） */
    onSubtasksToggleForListItem(task: Task): void {
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

    /** `TaskListItem` は `{ clientX, clientY, task }` を出す。親の `onKanbanTaskContextMenu` 用に `MouseEvent` を合成する */
    onListItemContextMenu(payload: { clientX: number; clientY: number; task: Task }): void {
        const ev = new MouseEvent('contextmenu', {
            clientX: payload.clientX,
            clientY: payload.clientY,
            bubbles: true,
            cancelable: true,
        });
        this.contextMenuRequest.emit({ ev, task: payload.task });
    }
    
    /** リスト用：ルート行と展開された子行をフラットに（ドラッグ検証用） */
    private visibleListRows(): { kind: 'root' | 'sub'; task: Task; parentId?: string }[] {
        const out: { kind: 'root' | 'sub'; task: Task; parentId?: string }[] = [];
        for (const t of this.DataService.displayRootTasks()) {
        out.push({ kind: 'root', task: t });
        const id = t.id;
        if (id && this.DataService.isSubtasksExpanded(id)) {
            for (const s of this.subtasksForParentList(id)) {
            out.push({ kind: 'sub', task: s, parentId: id });
            }
        }
        }
        return out;
    }

    private isValidListRowOrder(
        rows: { kind: 'root' | 'sub'; task: Task; parentId?: string }[],
    ): boolean {
        let currentRootId: string | null = null;
        for (const r of rows) {
        if (r.kind === 'root') {
            currentRootId = r.task.id ?? null;
        } else {
            if (!currentRootId || r.parentId !== currentRootId) {
            return false;
            }
        }
        }
        return true;
    }

    /** リストに表示中の行（ルート＋展開中の子）の ID */
    listSelectableTaskIds(): string[] {
        return this.DataService.listBulkSelectableTaskIds();
    }
    
    /** フィルタ初期・並び替え条件なしのときだけ手動ドラッグを有効にする */
    get canReorder(): boolean {
        const sk = this.DataService.sortKeys();
        return (
        isFilterDefaultForReorder(
            this.DataService.filterState(),
            this.taskScope.kind === 'project',
        ) &&
        sk.f1 === null &&
        sk.f2 === null &&
        sk.f3 === null
        );
    }
    
    onTaskDrop(event: CdkDragDrop<{ kind: 'root' | 'sub'; task: Task; parentId?: string }[]>): void {
        if (!this.canReorder) {
        return;
        }
        const rows = [...this.visibleListRows()];
        const prev = event.previousIndex;
        const cur = event.currentIndex;
        if (prev < 0 || prev >= rows.length || cur < 0 || cur > rows.length) {
        return;
        }

        const idxSelected = (i: number) => {
        const id = rows[i]?.task.id;
        return !!id && this.DataService.isTaskSelected(id);
        };

        const selectedIndices = new Set<number>();
        for (let i = 0; i < rows.length; i++) {
        if (idxSelected(i)) {
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
        const merged = [...rows];
        moveItemInArray(merged, prev, cur);
        if (!this.isValidListRowOrder(merged)) {
            return;
        }
        void this.persistFromVisibleRowOrder(merged);
        return;
        }

        const sortedSel = [...selectedIndices].sort((a, b) => a - b);
        const block = sortedSel.map((i) => rows[i]);
        const rest = rows.filter((_, i) => !selectedIndices.has(i));
        const k = insertionIndexInRestForMulti(rows.length, selectedIndices, cur);
        const merged = [...rest.slice(0, k), ...block, ...rest.slice(k)];
        if (!this.isValidListRowOrder(merged)) {
        return;
        }
        void this.persistFromVisibleRowOrder(merged);
    }

    /** リスト表示のフラット行順からルート順・各親の子順を保存 */
    private persistFromVisibleRowOrder(
        merged: { kind: 'root' | 'sub'; task: Task; parentId?: string }[],
    ): void {
        const roots: Task[] = [];
        let i = 0;
        while (i < merged.length) {
        const row = merged[i];
        if (row.kind !== 'root' || !row.task.id) {
            i++;
            continue;
        }
        roots.push(row.task);
        const pid = row.task.id;
        i++;
        const subs: Task[] = [];
        while (
            i < merged.length &&
            merged[i].kind === 'sub' &&
            merged[i].parentId === pid
        ) {
            subs.push(merged[i].task);
            i++;
        }
        if (subs.length > 0) {
            void this.persistSubtaskOrder(pid, subs);
        }
        }
        void this.persistTaskOrder(roots);
    }

    private async persistTaskOrder(ordered: Task[]): Promise<void> {
        const batch = writeBatch(this.firestore);
        ordered.forEach((task, index) => {
        const id = task.id;
        if (!id) {
            return;
        }
        const r = this.taskDocRef(id);
        if (!r) {
            return;
        }
        const v = index * 1000;
        batch.update(r, { listOrderIndex: v });
        });
        try {
        this.DataService.clearTaskSelection();
        await batch.commit();
        } catch (e) {
        console.error('persistTaskOrder failed:', e);
        }
    }

    private async persistSubtaskOrder(parentId: string, ordered: Task[]): Promise<void> {
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
        const v = index * 1000;
        batch.update(r, { listOrderIndex: v });
        });
        try {
        await batch.commit();
        } catch (e) {
        console.error('persistSubtaskOrder failed:', e);
        }
    }
}