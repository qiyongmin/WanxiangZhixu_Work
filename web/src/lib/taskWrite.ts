// Task 写入：node-update / reminder-handle / link-*；成功后统一走失效矩阵。
import { post } from './api';
import { afterWrite, invalidateTaskData } from './nodeData';
import type { LinkBody, NodeResult, NodeUpdateBody, TasksView } from './types';
import { setData } from './queryCache';

export interface UpdateResult extends NodeResult {
  createdIds?: string[];
  replayed?: boolean;
}

/** 一次 node-update（一条 Revision）。 */
export async function updateNode(
  id: string,
  baseRevision: number,
  changes: NodeUpdateBody['changes'],
): Promise<UpdateResult> {
  const result = await post<UpdateResult>('node-update', { id, baseRevision, changes });
  afterWrite(result.node);
  return result;
}

export type ReminderAction = { kind: 'handled' } | { kind: 'snooze'; minutes: 10 | 60 | 1440 };

export async function handleReminder(
  id: string,
  remindAt: string,
  revision: number,
  action: ReminderAction,
): Promise<NodeResult> {
  const body =
    action.kind === 'handled'
      ? { id, remindAt, kind: 'handled' }
      : { id, remindAt, kind: 'snooze', minutes: action.minutes, baseRevision: revision };
  const result = await post<NodeResult>('reminder-handle', body);
  afterWrite(result.node);
  return result;
}

export async function addLink(body: LinkBody): Promise<void> {
  await post('link-add', body);
  invalidateTaskData();
}

export async function removeLink(body: LinkBody): Promise<void> {
  await post('link-remove', body);
  invalidateTaskData();
}

/** Archive a node (one Revision); every task list / tree / cockpit cache is refreshed by `afterWrite`. */
export async function archiveNode(id: string, baseRevision: number): Promise<NodeResult> {
  const result = await post<NodeResult>('node-lifecycle', { id, baseRevision, operation: 'archive' });
  afterWrite(result.node);
  return result;
}
/** Bring an archived or deleted node back (`unarchive` / `restore`). */
export async function restoreNode(
  id: string,
  baseRevision: number,
  state: 'archived' | 'deleted',
): Promise<NodeResult> {
  const result = await post<NodeResult>('node-lifecycle', {
    id,
    baseRevision,
    operation: state === 'deleted' ? 'restore' : 'unarchive',
  });
  afterWrite(result.node);
  return result;
}
/** 在 Task 列表缓存中改写某一行（乐观更新 / 回滚 / 提交）。 */
export function patchTaskRow(
  key: string,
  taskId: string,
  patch: { status?: TasksView['items'][number]['status']; revision?: number; updatedAt?: string | null },
): void {
  setData<TasksView>(key, (current) => {
    const base = current ?? { items: [], total: 0 };
    return {
      ...base,
      items: base.items.map((row) => (row.id === taskId ? { ...row, ...patch } : row)),
    };
  });
}
