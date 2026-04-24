import { Task } from '../../models/task';

export function insertionIndexInRestForMulti(
    length: number,
    selectedIndices: ReadonlySet<number>,
    cur: number,
): number {
    if (cur === 0) return 0;
    const end = Math.max(0, Math.min(cur + 1, length));
    let k = 0;
    for (let i = 0; i < end; i++) {
    if (!selectedIndices.has(i)) {
        k++;
    }
    }
    return k;
}

export function insertIndexInColumnAfterRemovingBlock(
    origColumn: Task[],
    cur: number,
    blockIds: ReadonlySet<string>,
): number {
    const length = origColumn.length;
    const end = Math.max(0, Math.min(cur + 1, length));
    let k = 0;
    for (let i = 0; i < end; i++) {
    const id = origColumn[i]?.id;
    if (id && !blockIds.has(id)) {
        k++;
    }
    }
    return k;
}