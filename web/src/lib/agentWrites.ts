// Agent 写入的确认 / 撤销（Req 23）：调用 agent-confirm / agent-undo，被拒时状态不变并给出原因。
import { ApiError, post } from './api';
import { describeError } from './errors';
import { L3 } from './labels';
import { afterWrite } from './nodeData';
import { invalidate } from './queryCache';
import type { AgentWriteResult } from './types';

export type WriteAction = 'confirm' | 'undo';

export type ResolveResult = { ok: true; result: AgentWriteResult } | { ok: false; message: string; code: string };

/** 写入被确认或撤销后，使依赖它的视图过期并重取当前挂载的部分。 */
export function invalidateAgentData(): void {
  invalidate('notes:');
  invalidate('materials:');
  invalidate('summary-history:');
  invalidate('agent-writes');
  invalidate('proposals');
  invalidate('recent-writes');
}

export function rejectionMessage(error: unknown): { message: string; code: string } {
  if (error instanceof ApiError) {
    if (error.code === 'modified_since') return { message: L3.writeRejected, code: error.code };
    if (error.code === 'not_unconfirmed') return { message: L3.writeNotPending, code: error.code };
    return { message: describeError(error), code: error.code };
  }
  return { message: describeError(error), code: 'error' };
}

export async function resolveWrite(action: WriteAction, writeId: string): Promise<ResolveResult> {
  try {
    const result = await post<AgentWriteResult>(action === 'confirm' ? 'agent-confirm' : 'agent-undo', { writeId });
    afterWrite(result.node);
    invalidateAgentData();
    return { ok: true, result };
  } catch (error) {
    return { ok: false, ...rejectionMessage(error) };
  }
}
