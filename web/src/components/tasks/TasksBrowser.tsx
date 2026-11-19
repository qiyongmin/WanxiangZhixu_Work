import { lazy, Suspense, useCallback, useMemo, useState, type ReactNode } from 'react';
import { localToday } from '../../lib/dates';
import { describeError } from '../../lib/errors';
import { emptyFilters, filterTasks, sortTasks, type TaskFilterState } from '../../lib/filters';
import { L, L2 } from '../../lib/labels';
import type { QueryResult } from '../../lib/queryCache';
import { DEFAULT_TASKS_VIEW, KEYS, readJson, validateTasksView, writeJson, type TasksViewState } from '../../lib/storage';
import type { Status, TaskRow, TasksView } from '../../lib/types';
import { Icon } from '../icons';
import { TaskFilters, type SectionOption } from './TaskFilters';
import { TaskList } from './TaskList';

const Kanban = lazy(() => import('./Kanban'));

/** 列表/看板与「仅直属」：持久化到 `kbw:v1:tasks-view`，非法值回退「列表 + 仅直属关闭」。 */
export function useTasksViewState(): [TasksViewState, (patch: Partial<TasksViewState>) => void] {
  const [state, setState] = useState<TasksViewState>(() => readJson(KEYS.tasksView, validateTasksView, DEFAULT_TASKS_VIEW));
  const update = useCallback((patch: Partial<TasksViewState>) => {
    setState((current) => {
      const next = { ...current, ...patch };
      writeJson(KEYS.tasksView, next);
      return next;
    });
  }, []);
  return [state, update];
}

interface Props {
  query: QueryResult<TasksView>;
  queryKey: string;
  filters: TaskFilterState;
  onFiltersChange: (next: TaskFilterState) => void;
  view: TasksViewState['view'];
  onViewChange: (view: TasksViewState['view']) => void;
  /** 只在「任务 Tab」提供。 */
  directOnly?: { value: boolean; onChange: (value: boolean) => void };
  sections?: readonly SectionOption[];
  /** 额外可选 Tag（例如来自 view=tags）；与已加载 Task 的 Tag 合并。 */
  extraTags?: readonly string[];
  focusId?: string | null;
  banner?: ReactNode;
  /** 提供时列表行内可修改 Status（My_Tasks）。 */
  onStatusChange?: (task: TaskRow, to: Status) => void;
  /** When provided, a compact "+" button (New Task) is shown in the toolbar. */
  onCreate?: () => void;
  /** L1 Canvas only: source scope choices are strictly the current L1 and its direct L2 children. */
  sourceOptions?: readonly { id: string; label: string }[];
  projectRootId?: string;
  inlineDue?: boolean;
}

/** 任务 Tab 与 My_Tasks 共用：工具栏、过滤、两种空态、错误条（保留已显示内容）、列表/看板。 */
export function TasksBrowser({
  query,
  queryKey,
  filters,
  onFiltersChange,
  view,
  onViewChange,
  directOnly,
  sections,
  extraTags,
  focusId,
  banner,
  onStatusChange,
  onCreate,
  sourceOptions,
  projectRootId,
  inlineDue = false,
}: Props) {
  const [keyword, setKeyword] = useState('');
  const [source, setSource] = useState('');
  const today = localToday();
  const all = query.data?.items;
  const tags = useMemo(() => {
    const set = new Set<string>(extraTags ?? []);
    for (const task of all ?? []) for (const tag of task.tags) set.add(tag);
    return Array.from(set).sort();
  }, [all, extraTags]);
  const visible = useMemo(() => {
    const filtered = filterTasks(all ?? [], filters);
    const needle = keyword.trim().toLowerCase();
    const matched = needle ? filtered.filter((task) => task.title.toLowerCase().includes(needle)) : filtered;
    const scoped = !projectRootId || !source ? matched : matched.filter(task =>
      source === projectRootId ? task.parentId === projectRootId :
      task.parentId === source || task.path.some(item => item.id === source));
    return sortTasks(scoped);
  }, [all, filters, keyword, projectRootId, source]);

  const clearAll = () => {
    onFiltersChange(emptyFilters());
    setKeyword('');
    setSource('');
  };

  let body: ReactNode;
  if (!all) {
    body =
      query.status === 'error' ? null : (
        <p className="muted" role="status">
          {L.loading}
        </p>
      );
  } else if (all.length === 0) {
    body = <p className="muted">{L2.tasksEmptyScope}</p>;
  } else if (visible.length === 0) {
    body = (
      <div>
        <p className="muted">{L2.tasksEmptyFilter}</p>
        <button type="button" className="btn" onClick={clearAll}>
          {L2.clearFilters}
        </button>
      </div>
    );
  } else if (view === 'kanban') {
    body = (
      <Suspense
        fallback={
          <p className="muted" role="status">
            {L.loading}
          </p>
        }
      >
        <Kanban tasks={visible} queryKey={queryKey} today={today} inlineDue={inlineDue}/>
      </Suspense>
    );
  } else {
    body = <TaskList tasks={visible} today={today} focusId={focusId} onStatusChange={onStatusChange}
      inlineDue={inlineDue} sourceLinks={Boolean(projectRootId)}/>;
  }

  return (
    <div className="tasks-browser">
      <div className="tasks-toolbar">
        <div className="segmented" role="group" aria-label={L2.viewSwitchLabel}>
          {(['list', 'kanban'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={view === value ? 'btn is-active' : 'btn'}
              aria-pressed={view === value}
              onClick={() => onViewChange(value)}
            >
              <Icon name={value === 'list' ? 'list' : 'board'} />
              <span>{value === 'list' ? L2.viewList : L2.viewKanban}</span>
            </button>
          ))}
        </div>
        {directOnly ? (
          <label className="check-row">
            <input
              type="checkbox"
              checked={directOnly.value}
              onChange={(event) => directOnly.onChange(event.target.checked)}
            />
            <span>{L2.directOnly}</span>
          </label>
        ) : null}
        <label className="keyword">
          <span className="visually-hidden">{L2.keywordLabel}</span>
          <input
            type="search"
            data-search-input
            placeholder={L2.keywordLabel}
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
          />
        </label>
        <span className="muted task-count" aria-live="polite">
          {all ? L2.taskCountText(visible.length) : ''}
        </span>
        <TaskFilters filters={filters} onChange={onFiltersChange} tags={tags} sections={sections} />
        {sourceOptions?.length ? <label className="l1-source-filter">Source
          <select aria-label="Filter tasks by Workstream source" value={source}
            onChange={event=>setSource(event.target.value)}>
            <option value="">All Project</option>
            {sourceOptions.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
          </select></label>:null}
        {onCreate ? (
          <button type="button" className="btn btn-icon btn-primary toolbar-end" aria-label={L2.newTask} title={L2.newTask} onClick={onCreate}>
            <Icon name="plus" />
          </button>
        ) : null}
      </div>
      {banner}
      {query.status === 'error' ? (
        <div className="error-bar" role="alert">
          <span>
            {L2.tasksLoadFailed}: {describeError(query.error)}
          </span>
          <button type="button" className="btn" onClick={() => void query.refetch()}>
            {L.retry}
          </button>
        </div>
      ) : null}
      {body}
    </div>
  );
}
