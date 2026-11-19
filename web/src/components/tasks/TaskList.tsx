import { useEffect, useMemo } from 'react';
import { useListNav } from '../../lib/keyboard';
import { L, L2 } from '../../lib/labels';
import { navigate, nodePath } from '../../lib/router';
import type { Status, TaskRow } from '../../lib/types';
import { TaskRowItem } from './TaskRowItem';

interface Props {
  tasks: readonly TaskRow[];
  today: string;
  /** `?focus=<taskId>`：滚动到该行并高亮。 */
  focusId?: string | null;
  onStatusChange?: (task: TaskRow, to: Status) => void;
  inlineDue?: boolean;
  sourceLinks?: boolean;
}

/** Task 列表：J/K/Enter 导航；`content-visibility:auto` 让 500 条无需虚拟化。 */
export function TaskList({ tasks, today, focusId, onStatusChange, inlineDue, sourceLinks }: Props) {
  const ids = useMemo(() => tasks.map((task) => task.id), [tasks]);
  const nav = useListNav(ids, (id) => navigate(nodePath(id)));
  const { setActiveId } = nav;

  useEffect(() => {
    if (!focusId) return;
    const row = Array.from(document.querySelectorAll<HTMLElement>('[data-task-id]')).find(
      (element) => element.dataset.taskId === focusId,
    );
    row?.scrollIntoView?.({ block: 'center' });
  }, [focusId, ids]);

  return (
    <div className="task-table">
      <div className="task-list-head" aria-hidden="true">
        <span>{L.fieldTitle}</span>
        <span>{L.fieldStatus}</span>
        <span>{L2.priority}</span>
        <span>{L2.due}</span>
      </div>
      <ul className="task-list" aria-label={L2.taskListLabel}>
        {tasks.map((task) => (
          <TaskRowItem
            key={task.id}
            task={task}
            today={today}
            active={nav.activeId === task.id}
            focused={focusId === task.id}
            onActivate={setActiveId}
            onStatusChange={onStatusChange}
            inlineDue={inlineDue} sourceLinks={sourceLinks}
          />
        ))}
      </ul>
    </div>
  );
}
