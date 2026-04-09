export interface Task {
  id?: string;
  title: string;
  label: string;
  done: boolean;
  deadline?: Date | null;
}