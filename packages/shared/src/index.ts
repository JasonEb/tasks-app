export type TaskVisibility = 'public' | 'private';
export type TaskStatus = 'todo' | 'in_progress' | 'done';
export interface Task {
    id: string;
    ownerId: string;
    title: string;
    description: string | null;
    status: TaskStatus;
}