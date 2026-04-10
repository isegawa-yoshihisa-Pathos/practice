export interface Task {
  id?: string;
  title: string;
  label: string;
  done: boolean;
  /** 1（最低）〜5（最高） */
  priority: number;
  deadline?: Date | null;
  description?: string;
}