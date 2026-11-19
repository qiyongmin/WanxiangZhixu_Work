// Cross-Section Task list (view=tasks&scope=all): shared by My Tasks and the Cockpit Board / Week views.
import { get } from './api';
import { localNow } from './dates';
import { useQuery, type QueryResult } from './queryCache';
import type { TasksView } from './types';

export const ALL_TASKS_KEY = 'tasks:all';

export function useAllTasks(): QueryResult<TasksView> {
  return useQuery<TasksView>(ALL_TASKS_KEY, (signal) =>
    get<TasksView>('tasks', { scope: 'all', now: localNow() }, { signal }),
  );
}
