// Kanban / 看板的统一移动逻辑（Req 10）：鼠标拖拽与键盘「移动到…」菜单都走同一个 moveTask()。
import { ApiError } from './api';
import { describeError } from './errors';
import { L2 } from './labels';
import { isConflict } from './nodeData';
import type { Status } from './types';

export type MoveOutcome = 'noop' | 'cancelled' | 'moved' | 'conflict' | 'failed';

export interface MoveSubject {
  id: string;
  status: Status;
  revision: number;
  openChildCount: number;
}

export interface MoveDeps {
  /** 弹出「还有 N 个未完成子 Task」确认；返回是否确认。 */
  confirmDone: (openChildCount: number) => Promise<boolean>;
  /** 发送 node-update{changes:{status}}；返回新的 revision。 */
  send: (task: MoveSubject, to: Status) => Promise<{ revision: number }>;
  /** 把卡片移到某状态（乐观移动、回滚与提交共用）。 */
  apply: (taskId: string, status: Status, revision: number) => void;
  notify: (message: string) => void;
}

/**
 * `to` 为 null 表示释放在列外；与原列相同也不发请求。
 * 失败（含 409）时立即回滚到原列并提示，不留下半移动的状态。
 */
export async function moveTask(task: MoveSubject, to: Status | null, deps: MoveDeps): Promise<MoveOutcome> {
  if (to === null || to === task.status) return 'noop';
  if (to === 'Done' && task.openChildCount > 0) {
    const confirmed = await deps.confirmDone(task.openChildCount);
    if (!confirmed) return 'cancelled';
  }
  deps.apply(task.id, to, task.revision);
  try {
    const result = await deps.send(task, to);
    deps.apply(task.id, to, result.revision);
    return 'moved';
  } catch (error) {
    deps.apply(task.id, task.status, task.revision);
    if (isConflict(error)) {
      deps.notify(L2.moveConflict);
      return 'conflict';
    }
    const detail = error instanceof ApiError && error.fields.length > 0 ? error.fields[0]?.reason : describeError(error);
    deps.notify(`${L2.moveFailed}: ${detail ?? ''}`);
    return 'failed';
  }
}
