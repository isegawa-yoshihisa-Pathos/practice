import type { TaskStatus } from './task-status';

export interface Task {
  id?: string;
  title: string;
  label: string;
  /** 進捗（未着手 / 処理中 / 完了）。従来の done は Firestore 互換のため書き込み時に同期 */
  status: TaskStatus;
  priority: number;
  /**
   * 締切日時（1分単位）。`startAt`/`endAt` とは同時に持たない。
   */
  deadline?: Date | null;
  /** 開始日時（開始・終了ペア用） */
  startAt?: Date | null;
  /** 終了日時（開始・終了ペア用） */
  endAt?: Date | null;
  description?: string;
  /** プロジェクトタスクの担当ユーザー名（プライベートでは未使用） */
  assignee?: string | null;
  /**
   * 手動並び替え用（レガシー）。`listOrderIndex` / `kanbanOrderIndex` が無い文書では引き続きこれを参照
   */
  orderIndex?: number;
  /** リスト表示での順序（ルート同士・同一親の子同士）。カンバンとは独立 */
  listOrderIndex?: number;
  /** カンバン表示での順序（列内のルート・同一親の子同士）。リストとは独立 */
  kanbanOrderIndex?: number;
  /** カンバン表示時の列 ID（進捗 status とは独立） */
  kanbanColumnId?: string | null;
  /** 親タスク ID（子タスクのときのみ。1階層のみ） */
  parentTaskId?: string | null;
  /** Firestore の作成日時（レポート・集計用） */
  createdAt?: Date | null;
  /** Firestore の最終更新日時 */
  updatedAt?: Date | null;
  /** 完了にした日時（未完了時は null） */
  completedAt?: Date | null;
}
