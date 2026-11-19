/** Notes V3.5 · compact, allowlisted per-edge table borders (no arbitrary CSS). */
import type { Editor } from '@tiptap/react';
import { CellSelection, TableMap } from '@tiptap/pm/tables';

export const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const;
export const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'] as const;
export const BORDER_WIDTHS = [1, 2, 3] as const;
export const BORDER_COLORS = ['default', 'accent', 'red', 'green', 'amber', 'purple'] as const;
export type BorderSide = typeof BORDER_SIDES[number];
export type BorderStyle = typeof BORDER_STYLES[number];
export type BorderWidth = typeof BORDER_WIDTHS[number];
export type BorderColor = typeof BORDER_COLORS[number];
export type BorderScope = 'selection' | 'row' | 'column' | 'table';
export type BorderPlacement = 'all' | 'outer' | 'inner' | BorderSide;
export type BorderToken = `${BorderStyle}:${BorderWidth}:${BorderColor}` | 'none';
const borderKeys: Record<BorderSide, string> = {
  top: 'borderTop', right: 'borderRight', bottom: 'borderBottom', left: 'borderLeft',
};
const opposite: Record<BorderSide, BorderSide> = {
  top: 'bottom', right: 'left', bottom: 'top', left: 'right',
};
const tokenPattern = /^(solid|dashed|dotted|double):([123]):(default|accent|red|green|amber|purple)$/;
export function isBorderToken(value: unknown): value is BorderToken {
  return value === 'none' || (typeof value === 'string' && tokenPattern.test(value));
}
export function makeBorderToken(style: BorderStyle, width: BorderWidth, color: BorderColor): BorderToken {
  // Double lines need a 3px stroke to display reliably.
  return `${style}:${style === 'double' ? 3 : width}:${color}`;
}
export const borderCellAttributes = Object.fromEntries(BORDER_SIDES.map(side => [
  borderKeys[side],
  {
    default: null,
    parseHTML: (element: HTMLElement) => {
      const value = element.getAttribute('data-kbw-border-' + side);
      return isBorderToken(value) ? value : null;
    },
    renderHTML: (attrs: Record<string, unknown>) =>
      isBorderToken(attrs[borderKeys[side]])
        ? { ['data-kbw-border-' + side]: attrs[borderKeys[side]] } : {},
  },
]));

function tableLocation(editor: Editor) {
  const selection = editor.state.selection;
  const anchor = selection instanceof CellSelection ? selection.$anchorCell : selection.$from;
  let tableDepth = -1, cellDepth = -1;
  for (let depth = anchor.depth; depth > 0; depth--) {
    const kind = anchor.node(depth).type.name;
    if (cellDepth < 0 && (kind === 'tableCell' || kind === 'tableHeader')) cellDepth = depth;
    if (kind === 'table') { tableDepth = depth; break; }
  }
  if (tableDepth < 0 || (cellDepth < 0 && !(selection instanceof CellSelection))) return null;
  const table = anchor.node(tableDepth);
  const start = anchor.start(tableDepth);
  const map = TableMap.get(table);
  const cell = (selection instanceof CellSelection ? selection.$anchorCell.pos : anchor.before(cellDepth)) - start;
  if (cell < 0 || !map.map.includes(cell)) return null;
  return { selection, start, map, cell };
}

/** Apply one border preset to one or many cells/rows/columns.
 * A shared edge is mirrored to the adjacent cell, including the unselected
 * neighbor, so collapsed borders are consistent and "none" really hides it.
 * Merged cells use TableMap's logical grid; no unrelated table is modified.
 */
export function setTableBorders(
  editor: Editor, scope: BorderScope, placement: BorderPlacement, token: BorderToken,
): boolean {
  if (!isBorderToken(token) || !['selection', 'row', 'column', 'table'].includes(scope)
      || !['all', 'outer', 'inner', ...BORDER_SIDES].includes(placement)) return false;
  const location = tableLocation(editor);
  if (!location) return false;
  const { selection, start, map, cell } = location;
  const selected = new Set<number>();
  if (selection instanceof CellSelection) {
    selection.forEachCell((_node, pos) => {
      if (map.map.includes(pos - start)) selected.add(pos - start);
    });
  } else selected.add(cell);
  if (!selected.size) return false;

  const expand = new Set<number>(selected);
  if (scope === 'row' || scope === 'column') {
    const rowIndices = new Set<number>(), columnIndices = new Set<number>();
    for (const pos of selected) {
      const rect = map.findCell(pos);
      for (let r = rect.top; r < rect.bottom; r++) rowIndices.add(r);
      for (let c = rect.left; c < rect.right; c++) columnIndices.add(c);
    }
    for (let r = 0; r < map.height; r++) for (let c = 0; c < map.width; c++) {
      if ((scope === 'row' && rowIndices.has(r)) ||
          (scope === 'column' && columnIndices.has(c))) expand.add(map.map[r * map.width + c]!);
    }
  } else if (scope === 'table') map.map.forEach(pos => expand.add(pos));

  const changes = new Map<number, Record<string, BorderToken>>();
  const apply = (pos: number, side: BorderSide) => {
    const update = changes.get(pos) || {};
    update[borderKeys[side]] = token;
    changes.set(pos, update);
  };
  for (const pos of expand) {
    const rect = map.findCell(pos);
    for (const side of BORDER_SIDES) {
      const neighbors = new Set<number>();
      if (side === 'top' || side === 'bottom') {
        const row = side === 'top' ? rect.top - 1 : rect.bottom;
        if (row >= 0 && row < map.height)
          for (let col = rect.left; col < rect.right; col++)
            neighbors.add(map.map[row * map.width + col]!);
      } else {
        const col = side === 'left' ? rect.left - 1 : rect.right;
        if (col >= 0 && col < map.width)
          for (let row = rect.top; row < rect.bottom; row++)
            neighbors.add(map.map[row * map.width + col]!);
      }
      const outer = !neighbors.size || [...neighbors].some(n => !expand.has(n));
      const inner = [...neighbors].some(n => expand.has(n));
      const qualifies = placement === 'all' ||
        (placement === 'outer' && outer) || (placement === 'inner' && inner) ||
        (placement === side && outer);
      if (!qualifies) continue;
      apply(pos, side);
      for (const neighbor of neighbors) apply(neighbor, opposite[side]);
    }
  }
  const tr = editor.state.tr;
  for (const [pos, updates] of changes) {
    const absolute = start + pos;
    const node = tr.doc.nodeAt(absolute);
    if (!node || !['tableCell','tableHeader'].includes(node.type.name)) continue;
    if (Object.entries(updates).some(([key, value]) => node.attrs[key] !== value))
      tr.setNodeMarkup(absolute, undefined, { ...node.attrs, ...updates });
  }
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}
