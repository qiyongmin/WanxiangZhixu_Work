import { useCallback, useRef, useState, type ReactNode } from 'react';
import { L, L2 } from '../../lib/labels';
import { moveTask, type MoveOutcome } from '../../lib/moveTask';
import { showNotice } from '../../lib/notice';
import { patchTaskRow, updateNode } from '../../lib/taskWrite';
import type { Status, TaskRow } from '../../lib/types';
import { useAnnounce } from '../announce';
import { ModalDialog } from '../ModalDialog';

interface Pending {
  count: number;
  resolve: (confirmed: boolean) => void;
}

/** 「还有 N 个未完成子 Task」确认对话框（原生 dialog）。 */
export function useConfirmDone(): { confirm: (count: number) => Promise<boolean>; dialog: ReactNode } {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirm = useCallback(
    (count: number) =>
      new Promise<boolean>((resolve) => {
        setPending({ count, resolve });
      }),
    [],
  );
  const settle = (value: boolean) => {
    pending?.resolve(value);
    setPending(null);
  };
  const dialog = pending ? (
    <ModalDialog label={L2.confirmDoneTitle} onClose={() => settle(false)} className="modal-confirm">
      <h2>{L2.confirmDoneTitle}</h2>
      <p>{L2.confirmDoneBody(pending.count)}</p>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" data-autofocus onClick={() => settle(true)}>
          {L2.confirmDoneOk}
        </button>
        <button type="button" className="btn" onClick={() => settle(false)}>
          {L.cancel}
        </button>
      </div>
    </ModalDialog>
  ) : null;
  return { confirm, dialog };
}

/**
 * 面向某个 tasks 缓存 key 的统一移动函数：Kanban 指针、Kanban 菜单与 My_Tasks 状态修改共用。
 * 成功后以响应 revision 更新缓存，失败时回滚并提示。
 */
export function useTaskMover(queryKey: string): {
  move: (task: TaskRow, to: Status | null) => Promise<MoveOutcome>;
  dialog: ReactNode;
} {
  const announce = useAnnounce();
  const { confirm, dialog } = useConfirmDone();
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  const move = useCallback(
    async (task: TaskRow, to: Status | null) => {
      const outcome = await moveTask(task, to, {
        confirmDone: confirm,
        send: async (subject, status) => {
          const result = await updateNode(subject.id, subject.revision, { status });
          // Done history is grouped by the backend's acknowledged update time,
          // never the Task's stale timestamp from before completion.
          if (result.node.updatedAt) patchTaskRow(keyRef.current, subject.id, { updatedAt: result.node.updatedAt });
          return { revision: result.node.revision };
        },
        apply: (taskId, status, revision) => patchTaskRow(keyRef.current, taskId, { status, revision }),
        notify: (message) => {
          showNotice(message);
          announce(message);
        },
      });
      if (outcome === 'moved' && to) announce(`${L2.moved} ${to}`);
      return outcome;
    },
    [announce, confirm],
  );
  return { move, dialog };
}
