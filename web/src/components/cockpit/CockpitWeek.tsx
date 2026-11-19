import { useMemo, useState } from 'react';
import { useAllTasks } from '../../lib/allTasks';
import { addDays, isOverdue, localToday, parseDay, weekStart } from '../../lib/dates';
import { describeError } from '../../lib/errors';
import { sortTasks } from '../../lib/filters';
import { L, L2 } from '../../lib/labels';
import { nodePath } from '../../lib/router';
import type { TaskRow } from '../../lib/types';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { StatusBadge } from '../StatusBadge';

const WEEKDAYS = L2.weekdays;

export interface WeekLanes {
  overdue: TaskRow[];
  days: Array<{ date: string; label: string; tasks: TaskRow[] }>;
  noDate: TaskRow[];
}

/**
 * Lanes of the agenda. Each Task appears once: open overdue Tasks go to the Overdue lane (whichever week is shown),
 * open Tasks without a date go to "No date", everything else sits in the column of its due date (Done Tasks included).
 */
export function weekLanes(tasks: readonly TaskRow[], start: string, today: string): WeekLanes {
  const overdue: TaskRow[] = [];
  const noDate: TaskRow[] = [];
  const byDate = new Map<string, TaskRow[]>();
  for (const task of tasks) {
    if (isOverdue(task.dueDate, task.status, today)) overdue.push(task);
    else if (!task.dueDate) {
      if (task.status !== 'Done') noDate.push(task);
    } else {
      const list = byDate.get(task.dueDate) ?? [];
      list.push(task);
      byDate.set(task.dueDate, list);
    }
  }
  const days = WEEKDAYS.map((label, index) => {
    const date = addDays(start, index);
    return { date, label, tasks: sortTasks(byDate.get(date) ?? []) };
  });
  return { overdue: sortTasks(overdue), days, noDate: sortTasks(noDate) };
}

function dayNumber(date: string): string {
  const parsed = parseDay(date);
  return parsed ? `${parsed.getMonth() + 1}/${parsed.getDate()}` : date;
}

function AgendaTask({ task }: { task: TaskRow }) {
  return (
    <li className="agenda-task" data-task-id={task.id} data-status={task.status}>
      <AppLink to={nodePath(task.id)} className="task-title">
        {task.title}
      </AppLink>
      <StatusBadge status={task.status} />
      {task.path.length > 0 ? <span className="task-path muted">{task.path.map((item) => item.title).join(L2.pathSeparator)}</span> : null}
    </li>
  );
}

function Lane({ id, title, subtitle, tasks, today }: { id: string; title: string; subtitle?: string; tasks: TaskRow[]; today?: boolean }) {
  return (
    <section
      className={today ? 'agenda-lane is-today' : 'agenda-lane'}
      data-lane={id}
      aria-label={L2.weekDayLabel(subtitle ? `${title} ${subtitle}` : title, tasks.length)}
    >
      <h3 className="lane-head">
        <span>{title}</span>
        {subtitle ? <span className="lane-date">{subtitle}</span> : null}
        <span className="count-badge">{tasks.length}</span>
      </h3>
      {tasks.length === 0 ? <p className="muted lane-empty">{L2.weekEmptyDay}</p> : null}
      <ul className="lane-tasks">
        {tasks.map((task) => (
          <AgendaTask key={task.id} task={task} />
        ))}
      </ul>
    </section>
  );
}

/** Cockpit Week: No date first, then Overdue, then Monday–Friday. Weekends are optional. */
export default function CockpitWeek() {
  const query = useAllTasks();
  const today = localToday();
  const [start, setStart] = useState(() => weekStart(today));
  const [showWeekend, setShowWeekend] = useState(false);
  const lanes = useMemo(() => weekLanes(query.data?.items ?? [], start, today), [query.data, start, today]);

  if (!query.data) {
    return query.status === 'error' ? (
      <div className="error-bar" role="alert">
        <span>
          {L2.tasksLoadFailed}: {describeError(query.error)}
        </span>
        <button type="button" className="btn" onClick={() => void query.refetch()}>
          {L.retry}
        </button>
      </div>
    ) : (
      <p className="muted" role="status">
        {L.loading}
      </p>
    );
  }
  return (
    <div className="cockpit-week">
      <div className="week-nav">
        <button type="button" className="btn btn-icon" aria-label={L2.weekPrev} title={L2.weekPrev} onClick={() => setStart(addDays(start, -7))}>
          <span className="flip">
            <Icon name="chevron-right" />
          </span>
        </button>
        <button type="button" className="btn" onClick={() => setStart(weekStart(today))} disabled={start === weekStart(today)}>
          {L2.weekThis}
        </button>
        <button type="button" className="btn btn-icon" aria-label={L2.weekNext} title={L2.weekNext} onClick={() => setStart(addDays(start, 7))}>
          <Icon name="chevron-right" />
        </button>
        <span className="muted week-range">
          {start} – {addDays(start, 6)}
        </span>
        <button type="button" className="btn week-weekend-toggle"
          aria-pressed={showWeekend} onClick={() => setShowWeekend(current => !current)}>
          <Icon name="week" size={15}/>{showWeekend ? 'Hide Sat & Sun' : 'Show Sat & Sun'}
          {!showWeekend && lanes.days.slice(5).some(day=>day.tasks.length) ?
            <span className="count-badge">{lanes.days.slice(5).reduce((sum,day)=>sum+day.tasks.length,0)}</span> : null}
        </button>
      </div>
      <div className="agenda" role="group" aria-label={L2.weekLabel}>
        <Lane id="no-date" title={L2.weekNoDate} tasks={lanes.noDate} />
        <Lane id="overdue" title={L2.weekOverdueLane} tasks={lanes.overdue} />
        {(showWeekend ? lanes.days : lanes.days.slice(0,5)).map((day) => (
          <Lane
            key={day.date}
            id={day.date}
            title={day.label}
            subtitle={dayNumber(day.date)}
            tasks={day.tasks}
            today={day.date === today}
          />
        ))}
      </div>
    </div>
  );
}
