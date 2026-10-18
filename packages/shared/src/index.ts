export type TaskVisibility = 'public' | 'private';
export type TaskStatus = 'todo' | 'in_progress' | 'done';

export interface Task {
    id: string;
    ownerId: string;
    title: string;
    description: string | null;
    status: TaskStatus;
    visibility: TaskVisibility;
    createdAt: string;
    updatedAt: string;
}

export interface Comment {
    id: string;
    taskId: string;
    authorId: string | null;
    body: string;
    createdAt: string;
}

export interface CreateTaskBody {
    title: string;
    description?: string;
    visibility: TaskVisibility;
}

export interface UpdateTaskBody {
    title?: string;
    description?: string;
    status?: TaskStatus;
    visibility?: TaskVisibility;
}