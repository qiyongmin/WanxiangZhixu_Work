import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, useDraggable, useDroppable,
  useSensor, useSensors, type Announcements, type DragEndEvent, type DragStartEvent,
} from '@dnd-kit/core';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { describeError } from '../../lib/errors';
import { pushOverlay } from '../../lib/keyboard';
import { L, L2 } from '../../lib/labels';
import { isConflict } from '../../lib/nodeData';
import { showNotice } from '../../lib/notice';
import { nodePath } from '../../lib/router';
import { archiveNode } from '../../lib/taskWrite';
import { OPEN_STATUSES, STATUSES, type Status, type TaskRow } from '../../lib/types';
import { useAnnounce } from '../announce';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { ModalDialog } from '../ModalDialog';
import { StatusBadge } from '../StatusBadge';
import { DoneHistory } from './DoneHistory';
import { TagList, Progress, pathText } from './TaskMeta';
import { QuickPriority } from './QuickPriority';
import { QuickDueDate } from './QuickDueDate';
import { useTaskMover } from './useTaskMover';
import { daysOverdue, isOverdue } from '../../lib/dates';

const COLUMN_PREFIX = 'col:';
export function columnId(status: Status): string { return COLUMN_PREFIX + status; }
/** Done is deliberately not a drop target. Completion requires confirmation. */
export function columnOf(overId: string | number | null | undefined): Status | null {
  if (typeof overId !== 'string' || !overId.startsWith(COLUMN_PREFIX)) return null;
  const status = overId.slice(COLUMN_PREFIX.length);
  return (OPEN_STATUSES as readonly string[]).includes(status) ? status as Status : null;
}
/** Keep the five-status data model for compatibility. Only the four open groups render. */
export function groupByStatus(tasks: readonly TaskRow[]): Record<Status, TaskRow[]> {
  const groups = Object.fromEntries(STATUSES.map((status) => [status, [] as TaskRow[]])) as Record<Status, TaskRow[]>;
  for (const task of tasks) groups[task.status]?.push(task);
  return groups;
}

interface CardProps {
  task: TaskRow;
  today: string;
  onMove: (task: TaskRow, to: Status) => void;
  onArchive: (task: TaskRow) => void;
  onComplete: (task: TaskRow) => void;
  inlineDue?: boolean;
}

/** Structured card: title, date and context, then a distinct action footer.
 * Never display Notes presence/count on cards; the detail editor owns Notes. */
function CardFace({ task, today, inlineDue=false }: { task: TaskRow; today: string; inlineDue?:boolean }) {
  const overdue = isOverdue(task.dueDate, task.status, today);
  const subTotal = task.subtaskTotal ?? 0;
  const subDone = task.subtaskDone ?? 0;
  return (
    <>
      <AppLink to={nodePath(task.id)} className="task-title" draggable={false} title={task.title}>
        {task.title}
      </AppLink>
      <div className="kanban-card-facts">
        {inlineDue ? <QuickDueDate task={task}/> : <span className={overdue ? 'task-due-text is-overdue' : 'task-due-text'}>
          <span className="kanban-fact-label">Due</span> {task.dueDate ?? 'No due date'}
        </span>}
        {overdue ? <span className="flag flag-overdue">{L2.overdueDays(daysOverdue(task.dueDate, today))}</span> : null}
        {task.remindPending ? <span className="flag flag-remind"><Icon name="bell" size={12} /> Reminder due</span> : null}
        {task.assignee ? <span className="kanban-card-assignee" title="Assignee">{task.assignee}</span> : null}
      </div>
      {task.path.length ? (
        <span className="task-path" title={pathText(task)}>{pathText(task)}</span>
      ) : null}
      <TagList tags={task.tags}/>
      {subTotal > 0 ? (
        <div className="kanban-subtask-progress">
          <span className="muted">{L2.subtasksDone(subDone, subTotal)}</span>
          <Progress done={subDone} total={subTotal} label={L2.subtasksDone(subDone, subTotal)}/>
        </div>
      ) : null}
    </>
  );
}

const Card = memo(function Card({ task, today, onMove, onArchive, onComplete, inlineDue }: CardProps) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: task.id });
  const [menuOpen, setMenuOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!menuOpen) return undefined;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const release = pushOverlay(() => { setMenuOpen(false); trigger.current?.focus(); });
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => { release(); document.removeEventListener('pointerdown', onPointer); };
  }, [menuOpen]);
  const onMenuKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else if (event.key === 'Tab') setMenuOpen(false);
    if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
  };
  return (
    <li ref={setNodeRef} {...listeners}
      className={isDragging ? 'kanban-card is-dragging' : 'kanban-card'}
      data-task-id={task.id} data-status={task.status}>
      <div className="kanban-card-head">
        <button type="button" ref={setActivatorNodeRef} className="drag-handle"
          aria-label={`${L2.dragHandle}: ${task.title}`} {...attributes}>
          <Icon name="grip" size={14} />
        </button>
        <span className="kanban-card-kind">Task</span>
        <button type="button" className="card-complete"
          title={`Mark ${task.title} as Done`} aria-label={`Mark as Done: ${task.title}`}
          onClick={() => onComplete(task)}><Icon name="check" size={15}/></button>
      </div>
      <CardFace task={task} today={today} inlineDue={inlineDue}/>
      <div className="card-actions" role="group" aria-label={`${L2.cardActions}: ${task.title}`}>
        <QuickPriority task={task} />
        <button type="button" ref={trigger} className="btn card-move"
          aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>
          {L2.moveTo}
        </button>
        <button type="button" className="btn btn-icon card-archive"
          aria-label={L2.archiveTaskNamed(task.title)} title={L2.archiveTask}
          onClick={() => onArchive(task)}><Icon name="archive" size={14} /></button>
        {menuOpen ? (
          <ul role="menu" className="card-menu" aria-label={`${L2.moveToLabel}: ${task.title}`}
            ref={menu} onKeyDown={onMenuKey}>
            {OPEN_STATUSES.filter((status) => status !== task.status).map((status) => (
              <li role="none" key={status}>
                <button type="button" role="menuitem" className="menu-item" onClick={() => {
                  setMenuOpen(false); trigger.current?.focus(); onMove(task, status);
                }}><StatusBadge status={status} /></button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
});

function Column({ status, tasks, today, onMove, onArchive, onComplete, inlineDue }: {
  status: Status; tasks: TaskRow[]; today: string;
  onMove: CardProps['onMove']; onArchive: CardProps['onArchive']; onComplete: CardProps['onComplete']; inlineDue?:boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId(status) });
  return (
    <section ref={setNodeRef} className={isOver ? 'kanban-column is-over' : 'kanban-column'}
      data-column={status} aria-label={`${status} ${L2.kanbanColumn}, ${L2.taskCountText(tasks.length)}`}>
      <h3 className="column-head"><StatusBadge status={status}/><span className="count-badge">{tasks.length}</span></h3>
      {tasks.length === 0 ? <p className="muted column-empty">{L2.noCards}</p> : null}
      <ul className="column-cards">
        {tasks.map((task) => <Card key={task.id} task={task} today={today}
          onMove={onMove} onArchive={onArchive} onComplete={onComplete} inlineDue={inlineDue}/>)}
      </ul>
    </section>
  );
}
interface Props { tasks: readonly TaskRow[]; queryKey: string; today: string; inlineDue?:boolean }

/** Kanban everywhere: 4 active columns, historical Done timeline, explicit
 * per-card completion confirmation before any backend write. */
export default function Kanban({ tasks, queryKey, today, inlineDue }: Props) {
  const { move, dialog } = useTaskMover(queryKey);
  const announce = useAnnounce();
  const [history, setHistory] = useState(false);
  const [pendingDone, setPendingDone] = useState<TaskRow | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );
  const groups = useMemo(() => groupByStatus(tasks), [tasks]);
  const byId = useMemo(() => new Map(tasks.map((task) => [task.id, task] as const)), [tasks]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const tasksRef = useRef(byId);
  tasksRef.current = byId;
  const onMove = useCallback((task: TaskRow, to: Status) => void move(task, to), [move]);
  const onArchive = useCallback((task: TaskRow) => {
    archiveNode(task.id, task.revision).then(
      () => { const message = L2.archivedNotice(task.title); showNotice(message); announce(message); },
      (error: unknown) => {
        const detail = isConflict(error) ? L2.moveConflict : describeError(error);
        showNotice(`${L2.archiveFailed}: ${detail}`);
      },
    );
  }, [announce]);
  const confirmComplete = () => {
    if (!pendingDone) return;
    const task = pendingDone;
    setPendingDone(null);
    // The user has just confirmed, including any open children. Prevent a
    // redundant second child-count dialog in the shared task move flow.
    void move({ ...task, openChildCount: 0 }, 'Done');
  };
  const onDragStart = (event: DragStartEvent) => setActiveId(String(event.active.id));
  const onDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const task = tasksRef.current.get(String(event.active.id));
    if (task) void move(task, columnOf(event.over?.id));
  };
  const titleOf = (id: string | number) => tasksRef.current.get(String(id))?.title ?? '';
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${titleOf(active.id)}`,
    onDragOver: ({ active, over }) => {
      const to = columnOf(over?.id);
      return to ? `${titleOf(active.id)} is over the ${to} column` : `${titleOf(active.id)} is not over an active column`;
    },
    onDragEnd: ({ active, over }) => {
      const to = columnOf(over?.id);
      return to ? `Dropped ${titleOf(active.id)} in ${to}` : `Dropped ${titleOf(active.id)}, not moved`;
    },
    onDragCancel: ({ active }) => `Cancelled, ${titleOf(active.id)} stays in place`,
  };
  const dragging = activeId ? byId.get(activeId) : undefined;

  return (
    <div className="kanban-workspace">
      <div className="kanban-viewbar">
        <span className="muted">{history ? 'Completed Tasks' : 'Active Tasks'} · {history ?
          groups.Done.length : OPEN_STATUSES.reduce((n, status) => n + groups[status].length, 0)}</span>
        <button type="button" className={history ? 'btn done-history-button is-active' : 'btn done-history-button'}
          aria-pressed={history} onClick={() => setHistory((value) => !value)}>
          <Icon name={history ? 'board' : 'check'} size={15}/>
          {history ? 'Back to Board' : `Done history (${groups.Done.length})`}
        </button>
      </div>
      {history ? <DoneHistory tasks={tasks} onBack={() => setHistory(false)}/> : (
        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
          accessibility={{ announcements, screenReaderInstructions: { draggable: L2.dragInstructions } }}>
          <div className="kanban" role="group" aria-label={L2.kanbanLabel}>
            {OPEN_STATUSES.map((status) => (
              <Column key={status} status={status} tasks={groups[status]} today={today} inlineDue={inlineDue}
                onMove={onMove} onArchive={onArchive} onComplete={setPendingDone}/>
            ))}
          </div>
          <DragOverlay>
            {dragging ? <div className="kanban-card is-overlay"><CardFace task={dragging} today={today}/></div> : null}
          </DragOverlay>
        </DndContext>
      )}
      {pendingDone ? (
        <ModalDialog label="Confirm Task completion" onClose={() => setPendingDone(null)} className="modal-confirm">
          <h2>Mark Task as Done?</h2>
          <p>Complete <strong>{pendingDone.title}</strong>?</p>
          {pendingDone.openChildCount > 0 ? (
            <p className="flag flag-overdue">{L2.confirmDoneBody(pendingDone.openChildCount)}. Completing the parent does not delete its children.</p>
          ) : null}
          <p className="muted">The Task remains in Done history and can be reviewed later.</p>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setPendingDone(null)}>{L.cancel}</button>
            <button type="button" className="btn btn-primary" data-autofocus onClick={confirmComplete}>Confirm Done</button>
          </div>
        </ModalDialog>
      ) : null}
      {dialog}
    </div>
  );
}
