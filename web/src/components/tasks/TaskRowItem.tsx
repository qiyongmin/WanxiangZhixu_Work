import { memo } from 'react';
import { daysOverdue, isOverdue } from '../../lib/dates';
import { L2 } from '../../lib/labels';
import { nodePath } from '../../lib/router';
import { STATUSES, type Status, type TaskRow } from '../../lib/types';
import { UnconfirmedBadge } from '../agent/UnconfirmedMark';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { StatusBadge } from '../StatusBadge';
import { pathText, TagList, TaskCounts } from './TaskMeta';
import { QuickPriority } from './QuickPriority';
import { QuickDueDate } from './QuickDueDate';

export { pathText };

interface Props {
  task: TaskRow;
  today: string;
  active: boolean;
  focused: boolean;
  onActivate?: (id: string) => void;
  /** 提供时在行内显示状态选择（My_Tasks）；与看板共用 moveTask。 */
  onStatusChange?: (task: TaskRow, to: Status) => void;
  inlineDue?: boolean;
  sourceLinks?: boolean;
}

/** List row (React.memo): title, Status (quick change), Priority, Due_Date, counters, parent path, Tags, overdue flag. */
export const TaskRowItem = memo(function TaskRowItem({ task, today, active, focused, onActivate, onStatusChange, inlineDue, sourceLinks }: Props) {
  const overdue = isOverdue(task.dueDate, task.status, today);
  return (
    <li
      className={['task-row', active ? 'is-active' : '', focused ? 'is-focused' : ''].filter(Boolean).join(' ')}
      data-task-id={task.id}
      data-nav-id={task.id}
      data-active={active ? 'true' : undefined}
      aria-current={active ? 'true' : undefined}
      onClick={() => onActivate?.(task.id)}
    >
      <div className="task-main">
        <AppLink to={nodePath(task.id)} className="task-title">
          {task.title}
        </AppLink>
        {task.unconfirmed > 0 ? <UnconfirmedBadge /> : null}
        {overdue ? (
          <span className="flag flag-overdue">
            <span aria-hidden="true">⚠</span> {L2.overdueDays(daysOverdue(task.dueDate, today))}
          </span>
        ) : null}
        {task.remindPending ? (
          <span className="flag flag-remind">
            <Icon name="bell" size={12} /> {L2.remindDue}
          </span>
        ) : null}
        <TaskCounts task={task} />
      </div>
      <div className="task-cell task-cell-status">
        <span className="task-mobile-label">Status</span>
        <StatusBadge status={task.status} />
        {onStatusChange ? (
          <select
            className="status-select"
            aria-label={`${L2.changeStatus}: ${task.title}`}
            value={task.status}
            onChange={(event) => onStatusChange(task, event.target.value as Status)}
          >
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <div className="task-cell task-cell-priority">
        <span className="task-mobile-label">Priority</span>
        <QuickPriority task={task} />
      </div>
      <div className="task-cell task-cell-due">
        <span className="task-mobile-label">Due Date</span>
        {inlineDue?<QuickDueDate task={task}/>:<span className={overdue ? 'task-due-text is-overdue' : 'task-due-text'}>
          <span className="task-due">{task.dueDate ?? L2.noDue}</span>
        </span>}
      </div>
      <div className="task-meta">
        {task.path.length > 0 ? (
          sourceLinks?<span className="task-path l1-task-source" title={pathText(task)}>
            {task.path.map((entry,i)=><span key={entry.id}>
              {i>0?' › ':null}<AppLink to={nodePath(entry.id)}>{entry.title}</AppLink>
            </span>)}
          </span>:<span className="task-path" title={pathText(task)}>{pathText(task)}</span>
        ) : null}
        <TagList tags={task.tags} />
        {task.assignee ? <span className="muted" title={L2.fieldAssignee}>{task.assignee}</span> : null}
      </div>
    </li>
  );
});
