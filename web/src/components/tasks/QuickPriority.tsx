import { useEffect, useState } from 'react';
import { describeError } from '../../lib/errors';
import { L2 } from '../../lib/labels';
import { isConflict } from '../../lib/nodeData';
import { showNotice } from '../../lib/notice';
import { updateNode } from '../../lib/taskWrite';
import { PRIORITIES, type Priority, type TaskRow } from '../../lib/types';

/** One-revision quick priority edit used on both List and Board; never bypasses the normal API. */
export function QuickPriority({ task }: { task: TaskRow }) {
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(task.priority ?? '');
  useEffect(() => setSelected(task.priority ?? ''), [task.priority, task.revision, task.id]);

  const change = async (value: string) => {
    if (busy || value === selected) return;
    const previous = selected;
    setSelected(value);
    setBusy(true);
    try {
      await updateNode(task.id, task.revision, { priority: value as Priority });
    } catch (error) {
      setSelected(previous);
      showNotice(isConflict(error) ? L2.moveConflict : `${L2.priorityChangeFailed}: ${describeError(error)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <select
      className="status-select priority-quick-select"
      aria-label={`${L2.fieldPriority}: ${task.title}`}
      value={selected}
      disabled={busy}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onChange={(event) => void change(event.target.value)}
    >
      {selected === '' ? <option value="" disabled>{L2.noPriority}</option> : null}
      {PRIORITIES.map((priority) => (
        <option key={priority} value={priority}>{priority}</option>
      ))}
    </select>
  );
}
