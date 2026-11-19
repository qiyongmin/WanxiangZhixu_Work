// Left_Tree 的纯数据逻辑：分组、可见行、展开状态求交集、键盘移动。
import type { TreeNode, TreeSection, TreeView } from './types';

export interface TreeItem {
  kind: 'section' | 'node';
  id: string;
  title: string;
  level: number; // 1 = Section
  open: number;
  remind: boolean;
  unconfirmed: number;
  parentKey: string | null;
  hasChildren: boolean;
  status?: TreeNode['status'];
  node?: TreeNode;
}

/** Section 与节点 id 可能重名，因此树内用带前缀的 key。 */
export const sectionKey = (id: string) => `s:${id}`;
export const nodeKey = (id: string) => `n:${id}`;

export interface TreeModel {
  items: Map<string, TreeItem>;
  childrenOf: Map<string | null, string[]>;
  nodeIds: Set<string>;
  sectionIds: Set<string>;
}

export function buildModel(view: TreeView): TreeModel {
  const items = new Map<string, TreeItem>();
  const childrenOf = new Map<string | null, string[]>();
  const nodeIds = new Set<string>();
  const sectionIds = new Set<string>();
  const byId = new Map(view.nodes.map((node) => [node.id, node] as const));
  const add = (parent: string | null, key: string) => {
    const list = childrenOf.get(parent) ?? [];
    list.push(key);
    childrenOf.set(parent, list);
  };
  const usedSections = new Set(view.nodes.map((n) => n.sectionId));
  const sections: TreeSection[] = view.sections.filter((s) => !s.virtual || usedSections.has(s.id));
  for (const section of sections) {
    sectionIds.add(section.id);
    items.set(sectionKey(section.id), {
      kind: 'section', id: section.id, title: section.title, level: 1,
      open: section.open ?? 0, remind: Boolean(section.remind), unconfirmed: section.unconfirmed ?? 0,
      parentKey: null, hasChildren: false,
    });
    add(null, sectionKey(section.id));
  }
  for (const node of view.nodes) {
    nodeIds.add(node.id);
    const parentIsNode = node.parentId !== null && byId.has(node.parentId);
    const parentKey = parentIsNode ? nodeKey(node.parentId as string) : sectionKey(node.sectionId);
    if (!parentIsNode && !items.has(parentKey)) continue; // Missing Section: ignore (should not happen)
    items.set(nodeKey(node.id), {
      kind: 'node', id: node.id, title: node.title, level: node.depth + 1,
      open: node.open, remind: node.remind, unconfirmed: node.unconfirmed,
      parentKey, hasChildren: false, status: node.status, node,
    });
    add(parentKey, nodeKey(node.id));
  }
  for (const [parent, kids] of childrenOf) {
    if (parent !== null) {
      const item = items.get(parent);
      if (item) item.hasChildren = kids.length > 0;
    }
  }
  return { items, childrenOf, nodeIds, sectionIds };
}

/** 已保存的展开状态（节点/Section 的裸 ID）与当前树求交集，返回内部 key 集合。 */
export function intersectExpanded(saved: readonly string[], model: TreeModel): Set<string> {
  const result = new Set<string>();
  for (const id of saved) {
    const key = model.nodeIds.has(id) ? nodeKey(id) : model.sectionIds.has(id) ? sectionKey(id) : null;
    const item = key === null ? undefined : model.items.get(key);
    if (key !== null && item && item.hasChildren) result.add(key); // archived, deleted or unknown ids are ignored silently
  }
  return result;
}

/** 内部 key 集合 → 存储用的裸 ID 数组。 */
export function toStoredIds(keys: Iterable<string>): string[] {
  return Array.from(keys, (key) => key.slice(2));
}

/** 当前可见行（按文档顺序）。 */
export function visibleKeys(model: TreeModel, expanded: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (key: string) => {
    out.push(key);
    if (!expanded.has(key)) return;
    for (const child of model.childrenOf.get(key) ?? []) walk(child);
  };
  for (const key of model.childrenOf.get(null) ?? []) walk(key);
  return out;
}

/** 祖先 key 链（不含自身）。 */
export function ancestorKeys(model: TreeModel, key: string): string[] {
  const out: string[] = [];
  let current = model.items.get(key)?.parentKey ?? null;
  const guard = new Set<string>();
  while (current !== null && !guard.has(current)) {
    guard.add(current);
    out.push(current);
    current = model.items.get(current)?.parentKey ?? null;
  }
  return out;
}

export type TreeKeyAction =
  | { type: 'focus'; key: string }
  | { type: 'expand'; key: string }
  | { type: 'collapse'; key: string }
  | { type: 'open'; key: string }
  | { type: 'none' };

/** WAI-ARIA tree 键盘约定（设计 6.5）。 */
export function keyAction(
  model: TreeModel,
  expanded: ReadonlySet<string>,
  focused: string,
  key: string,
): TreeKeyAction {
  const rows = visibleKeys(model, expanded);
  const index = rows.indexOf(focused);
  const item = model.items.get(focused);
  if (index < 0 || !item) return { type: 'none' };
  switch (key) {
    case 'ArrowDown':
      return index + 1 < rows.length ? { type: 'focus', key: rows[index + 1] as string } : { type: 'none' };
    case 'ArrowUp':
      return index > 0 ? { type: 'focus', key: rows[index - 1] as string } : { type: 'none' };
    case 'Home':
      return { type: 'focus', key: rows[0] as string };
    case 'End':
      return { type: 'focus', key: rows[rows.length - 1] as string };
    case 'ArrowRight': {
      if (!item.hasChildren) return { type: 'none' };
      if (!expanded.has(focused)) return { type: 'expand', key: focused };
      const first = model.childrenOf.get(focused)?.[0];
      return first ? { type: 'focus', key: first } : { type: 'none' };
    }
    case 'ArrowLeft': {
      if (item.hasChildren && expanded.has(focused)) return { type: 'collapse', key: focused };
      return item.parentKey ? { type: 'focus', key: item.parentKey } : { type: 'none' };
    }
    case 'Enter':
    case ' ':
      return { type: 'open', key: focused };
    default:
      return { type: 'none' };
  }
}
