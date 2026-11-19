import { useMemo } from 'react';
import { nodePath } from '../../lib/router';
import type { TaskRow } from '../../lib/types';
import { AppLink } from '../AppLink';

export interface DoneBucket { day: string; items: TaskRow[] }

/** Historical task API exposes updatedAt, not a distinct completion timestamp.
 * Group by last update and label it precisely; do not invent a completion date. */
export function groupDoneByDay(tasks: readonly TaskRow[]): DoneBucket[] {
  const dated = tasks.filter((task) => task.status === 'Done').sort((a, b) =>
    (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
  const buckets = new Map<string, TaskRow[]>();
  for (const task of dated) {
    const date = task.updatedAt && !Number.isNaN(Date.parse(task.updatedAt))
      ? new Date(task.updatedAt).toLocaleDateString('sv-SE') : 'Unknown date';
    if (!buckets.has(date)) buckets.set(date, []);
    buckets.get(date)!.push(task);
  }
  return [...buckets].map(([day, items]) => ({ day, items }));
}

export function DonePath({ task }: { task: TaskRow }) {
  const trail = [...task.path, { id: task.id, title: task.title }];
  return (
    <div className="done-task-path" aria-label="Task hierarchy">
      {trail.map((item, index) => (
        <span key={item.id + index} className="done-level" data-level={Math.min(index + 1, 4)}
          title={item.title}>
          <strong>{index < 3 ? `L${index + 1}` : 'L4+'}</strong>
          <span>{item.title}</span>
        </span>
      ))}
    </div>
  );
}

export function DoneHistory({ tasks, onBack }: { tasks: readonly TaskRow[]; onBack: () => void }) {
  const groups = useMemo(() => groupDoneByDay(tasks), [tasks]);
  return (
    <section className="done-history" aria-label="Done history">
      <div className="done-history-head">
        <div>
          <h2>Done history <span className="count-badge">{tasks.filter((t) => t.status === 'Done').length}</span></h2>
          <p className="muted">Grouped by last updated date · original tasks and revisions are preserved</p>
        </div>
        <button type="button" className="btn" onClick={onBack}>Back to Board</button>
      </div>
      {groups.length === 0 ? <p className="muted done-empty">No completed Tasks match these filters.</p> : null}
      <div className="done-timeline">
        {groups.map((group) => (
          <section key={group.day} className="done-day" data-day={group.day}>
            <h3><time>{group.day}</time> <span className="count-badge">{group.items.length}</span></h3>
            <ul>
              {group.items.map((task) => (
                <li key={task.id} className="done-record" data-task-id={task.id}>
                  <div className="done-record-main">
                    <AppLink to={nodePath(task.id)} className="done-task-title">{task.title}</AppLink>
                    <span className="done-record-time" title={task.updatedAt ?? ''}>
                      {task.updatedAt && !Number.isNaN(Date.parse(task.updatedAt)) ? new Date(task.updatedAt).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : ''}
                    </span>
                  </div>
                  <DonePath task={task}/>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </section>
  );
}
