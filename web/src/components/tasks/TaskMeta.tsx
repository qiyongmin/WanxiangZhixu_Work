import { daysOverdue, isOverdue } from '../../lib/dates';
import { L2 } from '../../lib/labels';
import type { TaskRow } from '../../lib/types';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';

/** Parent path: every ancestor joined with `›`. */
export function pathText(task: Pick<TaskRow, 'path'>): string {
  return task.path.map((item) => item.title).join(L2.pathSeparator);
}

/** Context counters: sub-Task progress, materials and reminders. Notes are intentionally not counted on Task items. */
export function TaskCounts({ task }: { task: TaskRow }) {
  const total = task.subtaskTotal ?? 0;
  const done = task.subtaskDone ?? 0;
  const materials = task.materialCount ?? 0;
  const hasReminder = task.remindAt !== null && !task.remindPending;
  if (total === 0 && materials === 0 && !task.repeat && !hasReminder) return null;
  return (
    <span className="task-counts">
      {total > 0 ? (
        <span className="meta-count" data-count="subtasks" title={L2.subtasksDone(done, total)}>
          <Icon name="subtasks" size={12} />
          <span aria-hidden="true">
            {done}/{total}
          </span>
          <span className="visually-hidden">{L2.subtasksDone(done, total)}</span>
        </span>
      ) : null}
      {materials > 0 ? (
        <span className="meta-count" data-count="materials" title={L2.materialsCount(materials)}>
          <Icon name="paperclip" size={12} />
          <span aria-hidden="true">{materials}</span>
          <span className="visually-hidden">{L2.materialsCount(materials)}</span>
        </span>
      ) : null}
      {task.repeat ? (
        <span className="meta-count" data-count="repeat" title={L2.repeatsLabel}>
          <Icon name="repeat" size={12} />
          <span className="visually-hidden">{L2.repeatsLabel}</span>
        </span>
      ) : null}
      {hasReminder ? (
        <span className="meta-count" data-count="reminder" title={L2.reminderSet}>
          <Icon name="bell" size={12} />
          <span className="visually-hidden">{L2.reminderSet}</span>
        </span>
      ) : null}
    </span>
  );
}

/** Thin progress bar for done / total (decorative; the text next to it carries the value). */
export function Progress({ done, total, label }: { done: number; total: number; label: string }) {
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
      <span className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Tag chips (links to the tag page). */
export function TagList({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul className="tag-list" aria-label={L2.tagsLabel}>
      {tags.map((tag) => (
        <li key={tag}>
          <AppLink to={`/tag/${encodeURIComponent(tag)}`} className="tag-chip" draggable={false}>
            {tag}
          </AppLink>
        </li>
      ))}
    </ul>
  );
}

/** Priority tag, due date (overdue emphasised) and reminder flag: the facts shown on every Task card. */
export function TaskFacts({ task, today }: { task: TaskRow; today: string }) {
  const overdue = isOverdue(task.dueDate, task.status, today);
  return (
    <>
      {task.assignee ? <span className="chip" title={L2.fieldAssignee}>{task.assignee}</span> : null}
      {task.priority ? (
        <span className="chip" data-priority={task.priority}>
          {task.priority}
        </span>
      ) : null}
      <span className={overdue ? 'task-due-text is-overdue' : 'task-due-text'}>
        {L2.due}: <span className="task-due">{task.dueDate ?? L2.noDue}</span>
      </span>
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
    </>
  );
}
