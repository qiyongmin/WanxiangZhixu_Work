import { useMemo, useState } from 'react';
import { get } from '../../lib/api';
import { isOverdue, localNow, localToday } from '../../lib/dates';
import { emptyFilters, type TaskFilterState } from '../../lib/filters';
import { useQuery } from '../../lib/queryCache';
import { navigate, nodePath, useAppPath } from '../../lib/router';
import { openChildAdd, openQuickAdd } from '../../lib/ui';
import type { NodeDTO, TabId, TreeNode, TreeView, TasksView } from '../../lib/types';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { IconMenu } from '../Menu';
import { MaterialsExplorerV3 as MaterialsTab } from '../materials/MaterialsExplorerV3';
import { NotesTab } from '../notes/NotesTab';
import { TasksBrowser, useTasksViewState } from '../tasks/TasksBrowser';
import { tasksKey } from '../tasks/TasksTab';
import { useTaskMover } from '../tasks/useTaskMover';
import { ActivityTab } from './ActivityTab';
import { SummaryBlock } from './OverviewTab';
import { QuickAccess } from './QuickAccess';

export const isExplorerKind = (kind: NodeDTO['kind']): boolean =>
  kind === 'initiative' || kind === 'topic' || kind === 'knowledge_collection';

export function explorerChildren(tree: TreeView | undefined, parentId: string): TreeNode[] {
  return tree?.nodes.filter(entry => entry.parentId === parentId) ?? [];
}

/** L1 always owns its Canvas. Never implicitly select the first Workstream. */
export function explorerSelection(_path: string, _tab: TabId, _children: TreeNode[]): null {
  return null;
}
export type ExplorerPanel = 'workstreams' | 'tasks' | 'notes' | 'materials' | 'activity' | 'brief';
export function explorerPanel(path: string, tab: TabId): ExplorerPanel {
  if(tab !== 'overview') return tab;
  const legacyPanel=new URLSearchParams(path.split('?')[1] ?? '').get('panel');
  return legacyPanel === 'brief' ? 'brief' : legacyPanel === 'tasks' ? 'tasks' : 'workstreams';
}
/** Workstreams reuses L1 /overview, so existing bookmarks and L1 URLs stay stable. */
export function explorerUrl(rootId: string, panel: ExplorerPanel, childId: string | null): string {
  const tab: TabId = panel === 'brief' || panel === 'workstreams' ? 'overview' : panel;
  if (childId) return nodePath(childId, tab);
  return nodePath(rootId, tab) + (panel === 'brief' ? '?panel=brief' : '');
}

function isWorkstreamKind(item: TreeNode): boolean {
  return item.kind === 'workstream' || item.kind === 'campaign';
}

/** L1 canvas: no second navigation. Only the full project Tasks list crosses Level ownership. */
export function InitiativeExplorer({ node, tab, tree }: {
  node: NodeDTO; tab: TabId; tree: TreeView | undefined;
}) {
  const path = useAppPath();
  const activeTab = explorerPanel(path, tab);
  const allChildren = useMemo(() => explorerChildren(tree, node.id), [tree, node.id]);
  const workstreams = allChildren.filter(isWorkstreamKind);
  const groupLabel = node.kind === 'topic' ? 'Campaigns' : 'Workstreams';
  const [filters, setFilters] = useState<TaskFilterState>(emptyFilters);
  const [viewState, setViewState] = useTasksViewState();
  const queryKey = tasksKey(node.id, false);
  const query = useQuery<TasksView>(queryKey, signal =>
    get<TasksView>('tasks', { scope: 'node', id: node.id, direct: 0, now: localNow() }, { signal }));
  const { move, dialog } = useTaskMover(queryKey);
  const tasks = query.data?.items ?? [];
  const open = tasks.filter(task => task.status !== 'Done');
  const today = localToday();
  const attention = open.filter(task => task.status === 'Blocked' || task.status === 'Waiting' ||
    isOverdue(task.dueDate, task.status, today));
  const sourceOptions = useMemo(() => [
    { id: node.id, label: 'This L1 only' },
    ...workstreams.map(entry => ({ id: entry.id, label: entry.title })),
  ], [node.id, workstreams]);

  const changeTab = (next: ExplorerPanel) => navigate(explorerUrl(node.id, next, null));
  return (
    <section className="initiative-explorer l1-project-canvas" data-l1-explorer="true"
      data-l1-canvas="v3" data-l1-kind={node.kind} data-root-id={node.id}
      data-selected-id={node.id}>
      <div className="l1-primary-shortcuts" aria-label="L1 Quick Access">
        <QuickAccess node={node}/>
      </div>
      <div className="l1-explorer-metrics l1-canvas-metrics" aria-label="Project-wide task overview">
        <span className={attention.length ? 'l1-metric-attention has-attention' : 'l1-metric-attention'}>
          <strong>{attention.length}</strong> Needs Attention
        </span>
        <span><strong>{open.length}</strong> Open Tasks</span>
        <span><strong>{workstreams.length}</strong> {groupLabel}</span>
      </div>
      <details className="l1-project-brief">
        <summary><Icon name="overview" size={16}/>{node.displayKind} Brief
          <Icon name="chevron-down" size={15}/>
        </summary>
        <div className="l1-brief-content">
          {node.description ? <p className="l1-brief-description">{node.description}</p> : null}
          <SummaryBlock key={node.id} node={node}/>
        </div>
      </details>
      <nav className="l1-explorer-panels l1-canvas-tabs" aria-label="Project Canvas content">
        {(['workstreams', 'tasks', 'notes', 'materials'] as const).map(item => (
          <button type="button" key={item} aria-current={activeTab === item ? 'page' : undefined}
            aria-label={item === 'workstreams' ? groupLabel : item === 'tasks' ? 'L1-Tasks' : item === 'notes' ? 'L1-Notes' : 'Materials'}
            className={activeTab === item ? 'l1-panel-button is-active' : 'l1-panel-button'}
            onClick={() => changeTab(item)}>
            {item === 'workstreams' ? groupLabel : item === 'tasks' ? 'L1-Tasks' : item === 'notes' ? 'L1-Notes' : 'Materials'}
          </button>
        ))}
        <IconMenu label="More" icon="more" align="end"
          items={[{key:'activity',label:'Activity / Revision history',icon:'history',
            onSelect:()=>changeTab('activity')},
          {key:'brief',label:'Brief',icon:'overview',onSelect:()=>changeTab('brief')}]}/>
      </nav>
      <div className="l1-canvas-content" data-l1-panel={activeTab}>
        {activeTab === 'workstreams' ? <section className="l1-canvas-workstreams" aria-label={'Explore '+groupLabel}>
          <header>
            <div>
              <h2>{groupLabel}</h2>
              <p>Organize related work in a dedicated L2 workspace.</p>
            </div>
            {!node.archivedAt ? <button type="button" className="btn btn-primary l1-add-workstream"
              aria-label={node.kind === 'topic' ? 'New Campaign' : 'New Workstream'}
              onClick={()=>openChildAdd(node.id,node.kind)}>
              <Icon name="plus" size={16}/> New {node.kind === 'topic' ? 'Campaign' : 'Workstream'}
            </button> : null}
          </header>
          {workstreams.length ? <div className="l1-canvas-workstream-grid">
            {workstreams.map(item => {
              const children = tree?.nodes.filter(child => child.parentId === item.id) ?? [];
              return <AppLink key={item.id} to={nodePath(item.id)} className="l1-canvas-workstream-card"
                data-l1-child={item.id}>
                <div><strong>{item.title}</strong>
                  <span>{item.displayKind} · {item.open} open · {children.length} child items</span></div>
                <span className="l1-canvas-status" data-status={item.status}>{item.status}</span>
                <Icon name="open" size={17}/>
              </AppLink>;
            })}
          </div> : <div className="l1-workstreams-empty">
            <Icon name="folder" size={25}/>
            <div><strong>No {groupLabel} yet</strong>
              <p>Create one to group related tasks, Notes and Materials. This step is optional.</p>
            </div>
          </div>}
          <div className="l1-workstreams-direct-task">
            <p><strong>{groupLabel} are optional.</strong> For smaller projects, you can create Tasks directly under L1 without adding a {node.kind === 'topic' ? 'Campaign' : 'Workstream'}.</p>
            {!node.archivedAt ? <button type="button" className="btn l1-direct-task-button"
              onClick={()=>openQuickAdd('', node.id, node.id)}><Icon name="plus" size={15}/> New L1 Task</button> : null}
          </div>
        </section> : null}
        {activeTab === 'tasks' ? <>
          <div className="l1-canvas-panel-heading">
            <div><h2>Project Tasks</h2><p>L1-Tasks shows all tasks across this project — both directly under L1 and within descendant levels.</p></div>
            {!node.archivedAt ? <button type="button" className="btn btn-primary" onClick={() =>
              openQuickAdd('', node.id, node.id)}><Icon name="plus" size={15}/> New Task</button> : null}
          </div>
          <TasksBrowser query={query} queryKey={queryKey} filters={filters}
            onFiltersChange={setFilters} view={viewState.view}
            onViewChange={view => setViewState({view})}
            sourceOptions={sourceOptions} projectRootId={node.id} inlineDue
            onStatusChange={(task,to)=>{void move(task,to);}}/>
          {dialog}
        </> : null}
        <div className="l1-canvas-notes" hidden={activeTab !== 'notes'}>
          <NotesTab key={node.id} node={node} focused/>
        </div>
        {activeTab === 'materials' ? <MaterialsTab node={node}/> : null}
        {activeTab === 'activity' ? <ActivityTab node={node}/> : null}
        {activeTab === 'brief' ? <SummaryBlock node={node}/> : null}
      </div>
    </section>
  );
}
