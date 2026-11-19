import { useId } from 'react';
import { get } from '../../lib/api';
import { localNow } from '../../lib/dates';
import { describeError } from '../../lib/errors';
import { L, L2 } from '../../lib/labels';
import { isConflict } from '../../lib/nodeData';
import { showNotice } from '../../lib/notice';
import { useQuery } from '../../lib/queryCache';
import { nodePath } from '../../lib/router';
import { patchTaskRow, updateNode } from '../../lib/taskWrite';
import type { NodeDTO, TasksView } from '../../lib/types';
import { useAnnounce } from '../announce';
import { AppLink } from '../AppLink';
import { tasksKey } from './TasksTab';

interface NotesView {
  items: Array<{ id: string; title: string }>;
}
interface MaterialsView {
  items: Array<{ id: string; title: string }>;
}

/** Task 详情：子 Task 清单（勾选 = 对子 Task 的 node-update{status:'Done'}）与关联的 Note / Material 标题。 */
export function TaskDetail({ node }: { node: NodeDTO }) {
  const announce = useAnnounce();
  const uid = useId();
  const key = tasksKey(node.id, true);
  const children = useQuery<TasksView>(key, (signal) =>
    get<TasksView>('tasks', { scope: 'node', id: node.id, direct: 1, now: localNow() }, { signal }),
  );
  const notes = useQuery<NotesView>(`notes:${node.id}:${node.revision}`, (signal) =>
    get<NotesView>('notes', { id: node.id }, { signal }),
  );
  const materials = useQuery<MaterialsView>(`materials:${node.id}:${node.revision}`, (signal) =>
    get<MaterialsView>('materials', { id: node.id }, { signal }),
  );

  const complete = async (child: TasksView['items'][number]) => {
    // 先乐观显示为已勾选（1 秒内），失败再还原。
    patchTaskRow(key, child.id, { status: 'Done' });
    try {
      const result = await updateNode(child.id, child.revision, { status: 'Done' });
      patchTaskRow(key, child.id, { status: 'Done', revision: result.node.revision });
      announce(`${child.title}: ${L2.checkDone}`);
    } catch (error) {
      patchTaskRow(key, child.id, { status: child.status, revision: child.revision });
      const text = isConflict(error) ? L2.moveConflict : `${L.opFailed}: ${describeError(error)}`;
      showNotice(text);
      announce(text);
    }
  };

  const noteItems = notes.data?.items ?? [];
  const materialItems = materials.data?.items ?? [];
  const related = noteItems.length + materialItems.length;

  return (
    <>
      <section aria-labelledby={`${uid}-sub`}>
        <h2 id={`${uid}-sub`}>{L2.subTasks}</h2>
        {children.data && children.data.items.length > 0 ? (
          <ul className="check-list" aria-label={L2.subTasks}>
            {children.data.items.map((child) => (
              <li key={child.id} data-task-id={child.id}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={child.status === 'Done'}
                    disabled={child.status === 'Done'}
                    aria-label={`${L2.checkDone}: ${child.title}`}
                    onChange={() => void complete(child)}
                  />
                </label>
                <AppLink to={nodePath(child.id)}>{child.title}</AppLink>
                <span className="muted">{child.status}</span>
              </li>
            ))}
          </ul>
        ) : children.status === 'error' ? (
          <p role="alert" className="error-text">
            {describeError(children.error)}
          </p>
        ) : (
          <p className="muted">{children.data ? L2.subTasksEmpty : L.loading}</p>
        )}
      </section>
      <section aria-labelledby={`${uid}-rel`}>
        <h2 id={`${uid}-rel`}>{L2.relatedHeading}</h2>
        {related === 0 ? (
          <p className="muted">{notes.data && materials.data ? L2.relatedEmpty : L.loading}</p>
        ) : (
          <ul className="item-list">
            {noteItems.map((note) => (
              <li key={`n:${note.id}`}>
                <span>{note.title}</span> <span className="muted">{L2.relatedNotes}</span>
              </li>
            ))}
            {materialItems.map((material) => (
              <li key={`m:${material.id}`}>
                <span>{material.title}</span> <span className="muted">{L2.relatedMaterials}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
