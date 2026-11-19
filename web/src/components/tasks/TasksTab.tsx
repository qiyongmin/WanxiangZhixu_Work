import { useState } from 'react';
import { get } from '../../lib/api';
import { localNow } from '../../lib/dates';
import { emptyFilters, type TaskFilterState } from '../../lib/filters';
import { useQuery } from '../../lib/queryCache';
import { useRoute } from '../../lib/router';
import type { NodeDTO, TasksView } from '../../lib/types';
import { openQuickAdd } from '../../lib/ui';
import { canHaveChild } from '../../lib/nodeForm';
import { TasksBrowser, useTasksViewState } from './TasksBrowser';
import { useTaskMover } from './useTaskMover';

export function tasksKey(nodeId: string, direct: boolean): string {
  return `tasks:node:${nodeId}:${direct ? 1 : 0}`;
}

/** Tasks tab: a single `view=tasks` 拉取范围内全部 Task，过滤在客户端完成。 */
export function TasksTab({ node }: { node: NodeDTO }) {
  const [state, update] = useTasksViewState();
  const [filters, setFilters] = useState<TaskFilterState>(emptyFilters);
  const route = useRoute();
  const focusId = route.name === 'node' ? route.focus : null;
  const directOnly = focusId ? false : state.directOnly;
  const key = tasksKey(node.id, directOnly);
  const { move, dialog } = useTaskMover(key);
  const query = useQuery<TasksView>(key, (signal) =>
    get<TasksView>(
      'tasks',
      { scope: 'node', id: node.id, direct: directOnly ? 1 : 0, now: localNow() },
      { signal },
    ),
  );
  return (
    <>
    <TasksBrowser
      onStatusChange={(task, to) => void move(task, to)}
      query={query}
      queryKey={key}
      filters={focusId ? emptyFilters() : filters}
      onFiltersChange={setFilters}
      view={focusId ? 'list' : state.view}
      onViewChange={(view) => update({ view })}
      directOnly={{ value: directOnly, onChange: (directOnly) => update({ directOnly }) }}
      focusId={focusId}
      {...(canHaveChild(node.depth) && !node.archivedAt ? { onCreate: () => openQuickAdd('', node.id) } : {})}
    />
    {dialog}
    </>
  );
}
