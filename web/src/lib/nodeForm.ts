// Node_Detail 的纯逻辑：面包屑折叠、冲突差异、父节点 Depth 过滤、概览统计、Summary 预检。
import type { ApiError } from './api';
import { OPEN_STATUSES, type CurrentNodeView, type NodeDTO, type OpenStatus, type Status, type TreeNode } from './types';

export const MAX_DEPTH = 4; // Historical L4 nodes remain readable.
export const NEW_WORK_MAX_DEPTH = 3; // UI treats Level 3 as terminal.
export const SUMMARY_MAX = 5000;

// ---- 面包屑 ----
export interface Crumb {
  key: string;
  label: string;
  /** 应用内路径；当前节点没有。 */
  to: string | null;
}

export interface CrumbView {
  visible: Crumb[];
  /** 被折叠的中间层级（位于 visible[0] 与其后之间）。 */
  hidden: Crumb[];
}

/** 溢出时折叠中间层级，保留 Section（首项）、直接父节点与当前节点；少于 4 项不折叠。 */
export function collapseCrumbs(crumbs: Crumb[], collapsed: boolean): CrumbView {
  if (!collapsed || crumbs.length <= 3) return { visible: crumbs, hidden: [] };
  const first = crumbs[0] as Crumb;
  const tail = crumbs.slice(-2);
  return { visible: [first, ...tail], hidden: crumbs.slice(1, -2) };
}

/** 折叠判定：完整（未折叠）宽度超过可用宽度则折叠；可用宽度恢复后自动展开。 */
export function shouldCollapse(fullWidth: number, available: number): boolean {
  return fullWidth > available;
}

// ---- 冲突差异 ----
export interface Draft {
  title: string;
  status: Status;
  description: string;
}

export interface FieldDiff {
  field: 'title' | 'status' | 'description';
  mine: string;
  current: string;
}

const FIELDS = ['title', 'status', 'description'] as const;

/** 草稿与服务端当前版本逐字段比较，只返回不同的字段。 */
export function diffAgainstCurrent(draft: Draft, current: Pick<CurrentNodeView, 'title' | 'status' | 'description'>): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const field of FIELDS) {
    if (draft[field] !== current[field]) out.push({ field, mine: draft[field], current: current[field] });
  }
  return out;
}

/** 草稿相对已知基线的变更集合（用于 node-update 的 changes）。 */
export function changesFrom(draft: Draft, base: Pick<CurrentNodeView, 'title' | 'status' | 'description'>): Partial<Draft> {
  const out: Partial<Draft> = {};
  if (draft.title !== base.title) out.title = draft.title;
  if (draft.status !== base.status) out.status = draft.status;
  if (draft.description !== base.description) out.description = draft.description;
  return out;
}

export function draftOf(node: Pick<NodeDTO, 'title' | 'status' | 'description'>): Draft {
  return { title: node.title, status: node.status, description: node.description };
}

/** 400 `details.fields` → {字段: 中文原因}。 */
export function fieldReasons(error: ApiError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of error.fields) if (item.reason && !(item.field in out)) out[item.field] = item.reason;
  return out;
}

// ---- 创建子节点 ----
/** New Work tasks stop at Level 3; legacy Level 4 records are not modified. */
export function parentChoices(nodes: readonly TreeNode[]): TreeNode[] {
  return nodes.filter((node) => node.depth + 1 <= NEW_WORK_MAX_DEPTH);
}

export function canHaveChild(depth: number): boolean {
  return depth + 1 <= NEW_WORK_MAX_DEPTH;
}

// ---- 概览 ----
export interface OpenCount {
  status: OpenStatus;
  count: number;
}

/** Planned / In Progress / Waiting / Blocked 分别计数（缺失按 0）。 */
export function openCounts(stats: NodeDTO['stats'] | undefined): OpenCount[] {
  return OPEN_STATUSES.map((status) => ({ status, count: stats?.byStatus?.[status] ?? 0 }));
}

// ---- Summary ----
/** 按 Unicode 码点计数（与服务端 len() 一致）。 */
export function charCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

export function summaryTooLong(text: string): boolean {
  return charCount(text) > SUMMARY_MAX;
}

// ---- 后代 Task ----
/** 树中某节点的全部后代 Task（kind 为 task/action），按树顺序。 */
export function descendantTasks(nodes: readonly TreeNode[], rootId: string): TreeNode[] {
  const children = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const out: TreeNode[] = [];
  const stack = [...(children.get(rootId) ?? [])].reverse();
  while (stack.length > 0) {
    const node = stack.pop() as TreeNode;
    if (node.kind === 'task' || node.kind === 'action') out.push(node);
    for (const child of [...(children.get(node.id) ?? [])].reverse()) stack.push(child);
  }
  return out;
}
