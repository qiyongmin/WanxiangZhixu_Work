import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type TouchEvent } from 'react';
import { displaySectionTitle, L, L2, STATUS_ICONS } from '../lib/labels';
import { openCreate, openQuickAdd } from '../lib/ui';
import { Icon } from './icons';
import { IconMenu } from './Menu';
import { navigate, nodePath, shouldIntercept, withBase } from '../lib/router';
import { KEYS, readJson, validateStringArray, writeJson } from '../lib/storage';
import { afterSectionWrite, describeSectionError, sectionApi } from '../lib/phase4';
import { post } from '../lib/api';
import { invalidate } from '../lib/queryCache';
import { describeError } from '../lib/errors';
import {
  ancestorKeys,
  buildModel,
  intersectExpanded,
  keyAction,
  nodeKey,
  toStoredIds,
  visibleKeys,
} from '../lib/tree';
import type { TreeSection, TreeView } from '../lib/types';

/** Section 强调色循环的长度（tokens.css 的 --sec-1…--sec-6）。 */
const ACCENT_CYCLE = 6;


/** 按 sortOrder（再按 id）给真实 Section 依次分配 1…6 循环的强调色序号；虚拟「未归类」不参与。 */
export function sectionAccents(sections: readonly TreeSection[]): Map<string, number> {
  const ordered = sections
    .filter((section) => !section.virtual)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
  return new Map(ordered.map((section, index) => [section.id, (index % ACCENT_CYCLE) + 1] as const));
}

/** Move an entire Section in an existing ordered list; never touch node IDs. */
export function moveTreeSection(ids: string[], source: string, target: string): string[] | null {
  const from = ids.indexOf(source);
  const to = ids.indexOf(target);
  if (from < 0 || to < 0 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, source);
  return next;
}

/** Left_Tree header: a compact "+" menu with New Task / New Item / New Section. */
export function TreeHeader() {
  return (
    <div className="tree-head">
      <span className="tree-head-title">{L.treeHeading}</span>
      <IconMenu
        label={L2.createMenu}
        menuLabel={L2.createMenuLabel}
        icon="plus"
        align="end"
        items={[
          { key: 'task', label: L2.newTask, onSelect: () => openQuickAdd() },
          { key: 'item', label: L2.newItem, onSelect: () => openCreate('item') },
          { key: 'section', label: L2.newSection, onSelect: () => openCreate('section') },
        ]}
      />
    </div>
  );
}

interface Props {
  view: TreeView;
  /** 当前路由对应的节点 ID；不在节点页时为 null（无选中）。 */
  selectedId: string | null;
}

/** WAI-ARIA tree：role=tree/treeitem/group，roving tabindex，展开状态存 kbw:v1:tree-expanded。 */
export function LeftTree({ view, selectedId }: Props) {
  const model = useMemo(() => buildModel(view), [view]);
  const [savedIds, setSavedIds] = useState<string[]>(() => readJson(KEYS.treeExpanded, validateStringArray, []));
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [sectionMoving, setSectionMoving] = useState(false);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [nodeMoving, setNodeMoving] = useState(false);
  const [nodeError, setNodeError] = useState<string | null>(null);
  const draggedNode = useRef<string | null>(null);
  const nodeTouch = useRef<{key:string;x:number;y:number}|null>(null);
  const draggedSection = useRef<string | null>(null);
  const touchStart = useRef<{ id: string; x: number; y: number } | null>(null);
  // 已保存的展开集合与最新树求交集：已归档/删除/不存在的 ID 静默忽略。
  const expanded = useMemo(() => intersectExpanded(savedIds, model), [savedIds, model]);

  const selectedKey = selectedId !== null && model.nodeIds.has(selectedId) ? nodeKey(selectedId) : null;
  const ancestors = useMemo(() => (selectedKey ? new Set(ancestorKeys(model, selectedKey)) : new Set<string>()), [
    model,
    selectedKey,
  ]);

  const commit = useCallback((keys: Set<string>) => {
    const ids = toStoredIds(keys);
    setSavedIds(ids);
    writeJson(KEYS.treeExpanded, ids);
  }, []);

  // 深链进入某节点时，展开其祖先使其可见（只在选中节点或树变化时执行一次）。
  useEffect(() => {
    if (!selectedKey) return;
    const missing = Array.from(ancestors).filter((key) => !expanded.has(key));
    if (missing.length > 0) commit(new Set([...expanded, ...missing]));
    // 依赖里刻意不含 expanded：用户之后折叠祖先不应被这里覆盖。
  }, [selectedKey, model]);

  const rows = useMemo(() => visibleKeys(model, expanded), [model, expanded]);
  const tabKey =
    focusKey !== null && rows.includes(focusKey) ? focusKey : selectedKey !== null && rows.includes(selectedKey) ? selectedKey : rows[0];

  const toggle = (key: string) => {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    commit(next);
  };

  const focusRow = (key: string, root: HTMLElement) => {
    setFocusKey(key);
    const target = Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(
      (element) => element.dataset.key === key,
    );
    target?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
    const key = row?.dataset.key;
    if (!row || !key) return;
    const action = keyAction(model, expanded, key, event.key);
    if (action.type === 'none') return;
    event.preventDefault();
    event.stopPropagation();
    switch (action.type) {
      case 'focus':
        focusRow(action.key, event.currentTarget);
        break;
      case 'expand':
      case 'collapse':
        toggle(action.key);
        break;
      case 'open': {
        const item = model.items.get(action.key);
        if (!item) break;
        if (item.kind === 'section') toggle(action.key);
        else navigate(nodePath(item.id, item.node?.depth===3&&['task','action'].includes(item.node.kind)?'notes':'overview'));
        break;
      }
    }
  };

  const sortedSections = useMemo(() => view.sections.filter((s) => !s.virtual)
    .slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id)),
  [view.sections]);
  const sectionIds = sortedSections.map((s) => s.id);
  const moveSection = async (from: string, to: string) => {
    if (sectionMoving) return;
    const next = moveTreeSection(sectionIds, from, to);
    if (!next) return;
    setSectionMoving(true);
    setSectionError(null);
    try {
      await sectionApi.reorder(next);
      afterSectionWrite();
    } catch (error) {
      setSectionError('Could not reorder Sections: ' + describeSectionError(error));
      // Reread the authoritative Section order after a failed concurrent write.
      afterSectionWrite();
    } finally {
      setSectionMoving(false);
    }
  };
  const onSectionDragStart = (event: DragEvent<HTMLButtonElement>, id: string) => {
    if (sectionMoving) { event.preventDefault(); return; }
    draggedSection.current = id;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  };
  const onSectionDrop = (event: DragEvent<HTMLDivElement>, id: string) => {
    const source = draggedSection.current;
    if (!source) return;
    event.preventDefault();
    event.stopPropagation();
    draggedSection.current = null;
    void moveSection(source, id);
  };
  const onSectionTouchStart = (event: TouchEvent<HTMLButtonElement>, id: string) => {
    const point = event.touches[0];
    if (point && !sectionMoving) touchStart.current = { id, x: point.clientX, y: point.clientY };
  };
  const onSectionTouchEnd = (event: TouchEvent<HTMLButtonElement>) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || sectionMoving) return;
    const end = event.changedTouches[0];
    if (!end || Math.abs(end.clientY - start.y) < 18 ||
      Math.abs(end.clientY - start.y) < Math.abs(end.clientX - start.x)) return;
    const found = document.elementFromPoint(end.clientX, end.clientY)
      ?.closest<HTMLElement>('.tree-section[data-section-id]')?.dataset.sectionId;
    if (found && found !== start.id) {
      event.preventDefault();
      void moveSection(start.id, found);
    }
  };
  const moveNode = async (sourceKey:string,targetKey:string) => {
    if (nodeMoving || sectionMoving) return;
    const source=model.items.get(sourceKey);
    const target=model.items.get(targetKey);
    if (!source || !target || source.kind!=='node' || target.kind!=='node' ||
        !source.node || !target.node || source.parentKey!==target.parentKey ||
        source.node.depth>3 || target.node.depth>3) {
      setNodeError('只能在同一父节点下调整 L1 / L2 / L3 的顺序；跨层级不会改变归属。');
      return;
    }
    const siblings=(model.childrenOf.get(source.parentKey)??[]).filter(key=>model.items.get(key)?.kind==='node');
    const before=siblings.map(key=>model.items.get(key)!.id);
    const after=moveTreeSection(before,source.id,target.id);
    if (!after) return;
    setNodeMoving(true);
    setNodeError(null);
    try {
      await post('node-reorder',{
        ids:after,expectedIds:before,parentId:source.node.parentId,
        sectionId:source.node.parentId===null?source.node.sectionId:null,
      });
      invalidate('tree');
    } catch(error) {
      setNodeError('Could not reorder items: '+describeError(error));
      invalidate('tree'); // Concurrent tab order must be read from authoritative server.
    } finally {
      setNodeMoving(false);
    }
  };
  const onNodeDragStart=(event:DragEvent<HTMLButtonElement>,key:string)=>{
    if(nodeMoving || sectionMoving){event.preventDefault();return;}
    draggedNode.current=key;
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('text/plain',key);
  };
  const onNodeDrop=(event:DragEvent<HTMLDivElement>,key:string)=>{
    const source=draggedNode.current;
    if(!source)return;
    event.preventDefault();
    event.stopPropagation();
    draggedNode.current=null;
    void moveNode(source,key);
  };
  const onNodeTouchStart=(event:TouchEvent<HTMLButtonElement>,key:string)=>{
    const touch=event.touches[0];
    if(touch&&!nodeMoving)nodeTouch.current={key,x:touch.clientX,y:touch.clientY};
  };
  const onNodeTouchEnd=(event:TouchEvent<HTMLButtonElement>)=>{
    const start=nodeTouch.current;
    nodeTouch.current=null;
    if(!start||nodeMoving)return;
    const end=event.changedTouches[0];
    if(!end || Math.abs(end.clientY-start.y)<18 ||
       Math.abs(end.clientY-start.y)<Math.abs(end.clientX-start.x))return;
    const target=document.elementFromPoint(end.clientX,end.clientY)
      ?.closest<HTMLElement>('[role="treeitem"][data-key]')?.dataset.key;
    if(target&&target!==start.key){
      event.preventDefault();
      void moveNode(start.key,target);
    }
  };
  const accents = useMemo(() => sectionAccents(view.sections), [view.sections]);
  const sectionsById = useMemo(() => new Map(view.sections.map((section) => [section.id, section] as const)), [view.sections]);
  if (rows.length === 0) return <p className="muted tree-empty">{L.treeEmpty}</p>;

  const renderLevel = (parent: string | null): ReactNode => {
    const keys = model.childrenOf.get(parent) ?? [];
    return keys.map((key, index) => {
      const item = model.items.get(key);
      if (!item) return null;
      const isOpen = expanded.has(key);
      const isSelected = key === selectedKey;
      const isSection = item.kind === 'section';
      const nodeDepth = item.node?.depth ?? 0;
      const tier = nodeDepth > 3 ? 4 : nodeDepth;
      const siblingKeys=(model.childrenOf.get(item.parentKey)??[]).filter(sibling=>model.items.get(sibling)?.kind==='node');
      const canReorderNode=!isSection && nodeDepth<=3 && siblingKeys.length>1;
      const classes = [
        'tree-item',
        isSection ? 'tree-section' : '',
        isOpen ? 'is-open' : '',
        isSelected ? 'is-selected' : '',
        ancestors.has(key) ? 'is-ancestor' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const labelId = `tree-label-${key.replace(/[^A-Za-z0-9_-]/g, '_')}`;
      const title = item.kind === 'section' ? displaySectionTitle(item.title) : item.title;
      return (
        <li
          key={key}
          role="treeitem"
          data-key={key}
          data-section-id={isSection && !sectionsById.get(item.id)?.virtual ? item.id : undefined}
          data-accent={isSection ? (accents.get(item.id) ?? 'virtual') : undefined}
          data-tier={isSection ? undefined : tier}
          data-node-kind={item.node?.kind}
          className={classes}
          aria-level={item.level}
          aria-setsize={keys.length}
          aria-posinset={index + 1}
          aria-expanded={item.hasChildren ? isOpen : undefined}
          aria-selected={isSelected}
          aria-labelledby={labelId}
          tabIndex={key === tabKey ? 0 : -1}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setFocusKey(key);
          }}
        >
          <div
            className="tree-row"
            data-kind={item.kind}
            onDragOver={isSection ? (event) => { if (draggedSection.current) event.preventDefault(); } :
              (event)=>{ if(draggedNode.current)event.preventDefault(); }}
            onDrop={isSection ? (event) => onSectionDrop(event, item.id) :
              (event)=>onNodeDrop(event,key)}
            style={{ paddingInlineStart: `calc(var(--sp-2) + ${item.level - 1} * var(--sp-4))` }}
          >
            {isSection ? (
              <>
                <span className="tree-dot" aria-hidden="true" />
                {!sectionsById.get(item.id)?.virtual ? (
                  <button type="button" className="tree-section-grip"
                    draggable={!sectionMoving} disabled={sectionMoving}
                    aria-label={`Reorder Section: ${title}`}
                    title="Drag up or down to reorder; keyboard: ↑ / ↓"
                    onClick={(event) => event.stopPropagation()}
                    onDragStart={(event) => onSectionDragStart(event, item.id)}
                    onDragEnd={() => { draggedSection.current = null; }}
                    onTouchStart={(event) => onSectionTouchStart(event, item.id)}
                    onTouchEnd={onSectionTouchEnd}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                      event.preventDefault();
                      event.stopPropagation();
                      const index = sectionIds.indexOf(item.id);
                      const target = sectionIds[index + (event.key === 'ArrowUp' ? -1 : 1)];
                      if (target) void moveSection(item.id, target);
                    }}>
                    <Icon name="grip" size={15}/>
                  </button>
                ) : null}
              </>
            ) : item.hasChildren ? (
              <span
                className="tree-caret"
                aria-hidden="true"
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(key);
                }}
              >
                <Icon name="chevron-right" size={14} />
              </span>
            ) : (
              <span className="tree-caret" aria-hidden="true" />
            )}
            {item.kind === 'node' && item.status ? (
              <span className="tree-status" data-status={item.status} aria-hidden="true">
                {STATUS_ICONS[item.status]}
              </span>
            ) : null}
            {item.kind === 'node' ? (
              <a
                id={labelId}
                className="tree-label"
                aria-current={isSelected ? 'page' : undefined}
                title={item.hasChildren ? 'Click to open · double-click to expand or collapse' : undefined}
                href={withBase(nodePath(item.id, item.node?.depth===3&&['task','action'].includes(item.node.kind)?'notes':'overview'))}
                tabIndex={-1}
                onClick={(event) => {
                  setFocusKey(key);
                  if (shouldIntercept(event)) {
                    event.preventDefault();
                    // Single click selects/navigates only; double click toggles
                    // disclosure. Modifier-click retains browser native behavior.
                    navigate(nodePath(item.id, item.node?.depth===3&&['task','action'].includes(item.node.kind)?'notes':'overview'));
                  }
                }}
                onDoubleClick={(event) => {
                  if (!item.hasChildren) return;
                  event.preventDefault();
                  event.stopPropagation();
                  toggle(key);
                }}
              >
                {title}
              </a>
            ) : (
              <span id={labelId} className="tree-label tree-section-label" onDoubleClick={() => toggle(key)} title="Double-click to expand or collapse">
                {title}
              </span>
            )}
            {canReorderNode ? <button type="button" className="tree-node-grip"
              draggable={!nodeMoving} disabled={nodeMoving}
              aria-label={`Reorder ${item.node?.displayKind||'item'}: ${title}`}
              title="Drag to reorder siblings; keyboard ↑ / ↓"
              onClick={event=>event.stopPropagation()}
              onDragStart={event=>onNodeDragStart(event,key)}
              onDragEnd={()=>{draggedNode.current=null;}}
              onTouchStart={event=>onNodeTouchStart(event,key)}
              onTouchEnd={onNodeTouchEnd}
              onKeyDown={event=>{
                if(event.key!=='ArrowUp'&&event.key!=='ArrowDown')return;
                event.preventDefault();event.stopPropagation();
                const current=siblingKeys.indexOf(key);
                const neighbor=siblingKeys[current+(event.key==='ArrowUp'?-1:1)];
                if(neighbor)void moveNode(key,neighbor);
              }}>
              <Icon name="grip" size={14}/>
            </button> : null}
            {item.remind ? (
              <span className="remind-badge" data-remind="true">
                <Icon name="bell" size={12} /> {L2.reminderBadge}
              </span>
            ) : null}
            {isSection && sectionsById.get(item.id)?.itemKind ? (
              <button
                type="button"
                className="btn btn-icon btn-ghost tree-add"
                tabIndex={-1}
                aria-label={L2.newItemInSection(title)}
                title={L2.newItemInSection(title)}
                onClick={(event) => {
                  event.stopPropagation();
                  openCreate('item', item.id);
                }}
              >
                <Icon name="plus" size={14} />
              </button>
            ) : null}
            {isSection ? (
              <span
                className="tree-caret tree-caret-end"
                aria-hidden="true"
                onClick={(event) => {
                  event.stopPropagation();
                  toggle(key);
                }}
              >
                <Icon name="chevron-down" size={14} />
              </span>
            ) : null}
          </div>
          {item.hasChildren && isOpen ? <ul role="group">{renderLevel(key)}</ul> : null}
        </li>
      );
    });
  };

  return (
    <>
      {sectionError ? <p role="alert" className="tree-sort-error">{sectionError}</p> : null}
      {nodeError ? <p role="alert" className="tree-sort-error">{nodeError}</p> : null}
      <ul role="tree" aria-label={L.leftTreeLabel} className="tree" onKeyDown={onKeyDown}
        aria-busy={sectionMoving||nodeMoving}>
        {renderLevel(null)}
      </ul>
    </>
  );
}
