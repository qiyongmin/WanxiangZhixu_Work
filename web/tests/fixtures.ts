import type { TreeNode, TreeSection, TreeView } from '../src/lib/types';

export function section(id: string, title: string, open = 0): TreeSection {
  return { id, title, sortOrder: 0, itemKind: null, rules: {}, nodeCount: 0, open, remind: false, unconfirmed: 0 };
}

export function node(
  id: string,
  parentId: string | null,
  sectionId: string,
  depth: number,
  extra: Partial<TreeNode> = {},
): TreeNode {
  return {
    id,
    parentId,
    kind: depth === 1 ? 'initiative' : 'task',
    displayKind: depth === 1 ? 'Initiative' : 'Task',
    title: `节点 ${id}`,
    status: 'Planned',
    revision: 1,
    updatedAt: '2026-01-01T00:00:00',
    depth,
    sectionId,
    open: 0,
    remind: false,
    unconfirmed: 0,
    ...extra,
  };
}

/** sec ─ a ─ a1 ─ a1x；sec ─ b；sec2（Line… 旧名）─ c */
export function sampleTree(): TreeView {
  return {
    generatedAt: '2026-01-01T00:00:00',
    sections: [section('sec', 'Alpha', 3), section('sec2', ['Line', 'Management'].join(' '), 120)],
    nodes: [
      node('a', null, 'sec', 1, { open: 3 }),
      node('a1', 'a', 'sec', 2),
      node('a1x', 'a1', 'sec', 3),
      node('b', null, 'sec', 1, { open: 120 }),
      node('c', null, 'sec2', 1),
    ],
  };
}
