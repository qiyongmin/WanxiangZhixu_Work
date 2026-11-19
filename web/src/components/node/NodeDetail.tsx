import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError, get, post } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { L, TAB_LABELS } from '../../lib/labels';
import { afterWrite, keys } from '../../lib/nodeData';
import { useQuery } from '../../lib/queryCache';
import { navigate, nodePath, useAppPath } from '../../lib/router';
import { TABS, type NodeDTO, type NodeResult, type TabId, type TreeView } from '../../lib/types';
import { useAnnounce } from '../announce';
import { Breadcrumb } from './Breadcrumb';
import { NodeHeader } from './NodeHeader';
import { OverviewTab } from './OverviewTab';
import { TasksTab } from '../tasks/TasksTab';
import { MaterialsExplorerV3 as MaterialsTab } from '../materials/MaterialsExplorerV3';
import { NotesTab } from '../notes/NotesTab';
import { ActivityTab } from './ActivityTab';
import { FocusWorkspace, isFocusKind, isTerminalL3 } from './FocusWorkspace';
import { InitiativeExplorer, isExplorerKind } from './InitiativeExplorer';
import { QuickAccess } from './QuickAccess';

function goBack(): void {
  if (window.history.length > 1) window.history.back();
  else navigate('/');
}

export function NodeNotFound() {
  return (
    <section className="page" aria-labelledby="page-title">
      <h1 id="page-title">{L.nodeNotFound}</h1>
      <p className="muted">{L.nodeNotFoundBody}</p>
      <button type="button" className="btn" onClick={goBack}>
        {L.back}
      </button>
    </section>
  );
}

function TabBar({ id, tab }: { id: string; tab: TabId }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(tab);
    let next = -1;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    navigate(nodePath(id, TABS[next] as TabId));
    window.setTimeout(() => refs.current[next]?.focus(), 0);
  };
  return (
    <div className="tabs" role="tablist" aria-label={L.tabsLabel} onKeyDown={onKeyDown}>
      {TABS.map((name, index) => (
        <button
          key={name}
          type="button"
          role="tab"
          id={`tab-${name}`}
          aria-selected={name === tab}
          aria-controls="tabpanel"
          tabIndex={name === tab ? 0 : -1}
          ref={(element) => {
            refs.current[index] = element;
          }}
          className={name === tab ? 'tab is-active' : 'tab'}
          onClick={() => navigate(nodePath(id, name))}
        >
          {TAB_LABELS[name]}
        </button>
      ))}
    </div>
  );
}

function TabContent({ node, tab }: { node: NodeDTO; tab: TabId }) {
  switch (tab) {
    case 'tasks':
      return <TasksTab node={node} />;
    case 'notes':
      return <NotesTab node={node} />;
    case 'materials':
      return <MaterialsTab node={node} />;
    case 'activity':
      return <ActivityTab node={node} />;
    default:
      return <OverviewTab node={node} />;
  }
}

/** Resolve the owning L1 without copying its shortcuts into child records. */
export function rootAccessId(id: string, tree: TreeView | undefined): string | null {
  const nodes = new Map(tree?.nodes.map((row) => [row.id, row]) ?? []);
  const visited = new Set<string>();
  let current = nodes.get(id);
  while (current && !visited.has(current.id)) {
    if (current.depth === 1) {
      return isExplorerKind(current.kind) ? current.id : null;
    }
    visited.add(current.id);
    current = current.parentId ? nodes.get(current.parentId) : undefined;
  }
  return null;
}

function InheritedAccess({ node, tree }: { node: NodeDTO; tree: TreeView | undefined }) {
  const owner = rootAccessId(node.id, tree);
  const query = useQuery<NodeDTO>(owner ? keys.node(owner) : 'quick-access:no-root',
    (signal) => get<NodeDTO>('node', { id: owner }, { signal }), { enabled: Boolean(owner) });
  if (!owner || !query.data?.resourceLinks?.length) return null;
  return <QuickAccess node={query.data} inherited />;
}

/** Redirect legacy focus URLs after Node depth is known, without creating
 * a Back-button loop. L3 entry/Overview/Tasks now open Notes; old Material
 * preview bookmarks still open Materials. L2 keeps Task Overview behavior.
 * L4 historical nodes are not deleted or rewritten.
 */
export function focusEntryTarget(node:NodeDTO,tab:TabId,path:string):string|null {
  const terminal=isTerminalL3(node);
  if (!terminal && tab!=='tasks') return null;
  if (terminal && tab!=='overview' && tab!=='tasks') return null;
  const params=new URLSearchParams(path.split('?')[1]??'');
  const destination:TabId=terminal ? (params.has('preview')?'materials':'notes') : 'overview';
  if(terminal){
    // focus/child/scope belonged to the removed L3 Task Overview, not Notes.
    for(const old of ['focus','child','scope'])params.delete(old);
  }
  const query=params.toString();
  const target=nodePath(node.id,destination)+(query?'?'+query:'');
  return path===target?null:target;
}
function FocusLegacyTasksRedirect({node,tab}:{node:NodeDTO;tab:TabId}) {
  const path=useAppPath();
  const target=focusEntryTarget(node,tab,path);
  useEffect(()=>{if(target)navigate(target,{replace:true});},[target]);
  return null;
}

/** Map pre-Canvas ?child=... bookmarks to their canonical dedicated child route.
 * Reject archived/deleted, unrelated and cyclic child nodes; never redirect cross-L1. */
export function l1LegacyChildTarget(path:string,rootId:string,tab:TabId,tree:TreeView|undefined):string|null {
  const params=new URLSearchParams(path.split('?')[1]??'');
  const childId=params.get('child');
  if(!childId||!tree)return null;
  const nodes=new Map(tree.nodes.map(n=>[n.id,n]));
  const child=nodes.get(childId);
  if(!child||child.id===rootId)return null;
  let cursor=child;const visited=new Set<string>();
  while(cursor.parentId&&!visited.has(cursor.id)){
    visited.add(cursor.id);
    if(cursor.parentId===rootId){
      const targetTab=tab==='overview' ? 'overview' : tab;
      const preserved=new URLSearchParams();
      for(const key of ['note','page','section','preview','focus','view','event']){
        const value=params.get(key);if(value)preserved.set(key,value);
      }
      if(params.get('panel')==='brief')preserved.set('brief','1');
      return nodePath(childId,targetTab)+(preserved.size?'?'+preserved.toString():'');
    }
    cursor=nodes.get(cursor.parentId)!;
    if(!cursor)return null;
  }
  return null;
}

/** 面包屑 → 标题区 → Tab 栏 → Tab 内容；Item / Sub_Item / Task 完全相同。 */
export function NodeDetail({ id, tab }: { id: string; tab: TabId }) {
  const announce = useAnnounce();
  const query = useQuery<NodeDTO>(keys.node(id), (signal) => get<NodeDTO>('node', { id }, { signal }));
  const tree = useQuery<TreeView>('tree', (signal) => get<TreeView>('tree', {}, { signal }));
  const path=useAppPath();
  const oldChild=new URLSearchParams(path.split('?')[1]??'').get('child');
  const target=query.data&&tree.data&&isExplorerKind(query.data.kind)&&query.data.depth===1
    ? l1LegacyChildTarget(path,id,tab,tree.data):null;
  useEffect(()=>{if(target)navigate(target,{replace:true});},[target]);
  const [deleted, setDeleted] = useState<NodeDTO | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const restore = async () => {
    if (!deleted) return;
    setRestoreError(null);
    try {
      const result = await post<NodeResult>('node-lifecycle', {
        id: deleted.id,
        baseRevision: deleted.revision,
        operation: 'restore',
      });
      afterWrite(result.node);
      setDeleted(null);
      announce(L.restored);
    } catch (error) {
      const message = `${L.opFailed}: ${describeError(error)}`;
      setRestoreError(message);
      announce(message);
    }
  };

  if (deleted) {
    return (
      <section className="page" aria-labelledby="page-title">
        <h1 id="page-title">{L.deleted}</h1>
        <p className="muted">{deleted.title}</p>
        {restoreError ? (
          <p role="alert" className="error-text">
            {restoreError}
          </p>
        ) : null}
        <div className="form-actions">
          <button type="button" className="btn btn-primary" onClick={() => void restore()}>
            {L.restore}
          </button>
          <button type="button" className="btn" onClick={goBack}>
            {L.back}
          </button>
        </div>
      </section>
    );
  }

  const notFound = query.error instanceof ApiError && query.error.status === 404;
  if (notFound) return <NodeNotFound />;
  const node = query.data;
  if (!node) {
    if (query.status === 'error') {
      return (
        <section className="page">
          <p role="alert" className="error-text">
            {describeError(query.error)}
          </p>
          <button type="button" className="btn" onClick={() => void query.refetch()}>
            {L.retry}
          </button>
        </section>
      );
    }
    return (
      <p className="muted" role="status">
        {L.loading}
      </p>
    );
  }

  if(target)return <p role="status" className="muted">Opening dedicated workspace…</p>;
  const section = tree.data?.sections.find((item) => item.id === node.sectionId);
  const focus = isFocusKind(node.kind);
  const explorer = isExplorerKind(node.kind) && node.depth === 1;
  return (
    <div className={focus ? 'node-detail node-detail-focus' : explorer ? 'node-detail node-detail-explorer' : 'node-detail'} data-node-id={node.id}>
      <Breadcrumb node={node} sectionTitle={section?.title ?? null} />
      {oldChild && explorer && tree.data && !target ? <div role="alert" className="error-bar">
        This bookmarked child is no longer available in this project. Showing the L1 Project Canvas.
        <button className="btn" type="button" onClick={()=>navigate(nodePath(id),{replace:true})}>Clear invalid child link</button>
      </div>:null}
      <NodeHeader key={node.id} node={node} onDeleted={setDeleted} hideDescription={explorer} />
      {focus ? <>
        <FocusLegacyTasksRedirect node={node} tab={tab}/>
        <FocusWorkspace node={node} tab={tab} quickAccess={<InheritedAccess node={node} tree={tree.data}/>} />
      </> : explorer ? (
        <InitiativeExplorer node={node} tab={tab} tree={tree.data}/>
      ) : (
        <>
          <TabBar id={node.id} tab={tab} />
          <div id="tabpanel" role="tabpanel" aria-labelledby={`tab-${tab}`} tabIndex={0} className="tabpanel">
            <TabContent node={node} tab={tab} />
          </div>
        </>
      )}
    </div>
  );
}
