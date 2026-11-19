import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../../lib/api';
import { ALL_TASKS_KEY, useAllTasks } from '../../lib/allTasks';
import { localToday } from '../../lib/dates';
import { describeError } from '../../lib/errors';
import {
  dropStaleFilters, emptyFilters, filterTasks, serializeFilterState,
  sortTasks, validateFilterState, type TaskFilterState,
} from '../../lib/filters';
import { displaySectionTitle, L, L2 } from '../../lib/labels';
import { useQuery } from '../../lib/queryCache';
import { KEYS, readJson, writeJson } from '../../lib/storage';
import type { TagCount, TaskRow, TreeView } from '../../lib/types';
import { TaskFilters, type SectionOption } from '../tasks/TaskFilters';
import Kanban from '../tasks/Kanban';

/** Keep exported for existing clients/tests: Board includes all Done history
 * rather than silently deleting completed items or showing only today's Done. */
export function boardTasks(tasks: readonly TaskRow[], _today: string): TaskRow[] {
  return [...tasks];
}

/** Cockpit Board is the single cross-Section Tasks workspace.
 * Reuses the persisted My Tasks filter contract so a removed navigation item
 * cannot cause lost user preferences or change any task status. */
export default function CockpitBoard() {
  const query = useAllTasks();
  const tree = useQuery<TreeView>('tree', (signal) => get<TreeView>('tree', {}, { signal }));
  const tags = useQuery<TagCount[]>('tags', (signal) => get<TagCount[]>('tags', {}, { signal }));
  const [filters, setFiltersState] = useState<TaskFilterState>(() =>
    readJson(KEYS.mytasksFilters, (value) => validateFilterState(value) ?? undefined, emptyFilters()),
  );
  const [keyword, setKeyword] = useState('');
  const [ignored, setIgnored] = useState(false);
  const checked = useRef(false);
  const today = localToday();
  const tagNames = useMemo(() => (tags.data ?? []).map((item) => item.tag), [tags.data]);
  const sections = useMemo<SectionOption[]>(() => {
    const used = new Set(tree.data?.nodes.map((node) => node.sectionId));
    return (tree.data?.sections ?? [])
      .filter((section) => !section.virtual || used.has(section.id))
      .map((section) => ({ id: section.id, title: displaySectionTitle(section.title) }));
  }, [tree.data]);

  useEffect(() => {
    if (checked.current || !tree.data || !tags.data) return;
    checked.current = true;
    const cleaned = dropStaleFilters(filters,
      new Set(tree.data.sections.map((section) => section.id)), new Set(tagNames));
    if (cleaned.ignored) {
      setIgnored(true);
      setFiltersState(cleaned.filters);
      writeJson(KEYS.mytasksFilters, serializeFilterState(cleaned.filters));
    }
  }, [tree.data, tags.data, filters, tagNames]);

  const setFilters = useCallback((next: TaskFilterState) => {
    setIgnored(false);
    setFiltersState(next);
    writeJson(KEYS.mytasksFilters, serializeFilterState(next));
  }, []);

  const rows = useMemo(() => {
    const matched = filterTasks(query.data?.items ?? [], filters);
    const search = keyword.trim().toLocaleLowerCase();
    return sortTasks(search ? matched.filter((task) =>
      [task.title, ...task.path.map((item) => item.title)].join(' ').toLocaleLowerCase().includes(search)) : matched);
  }, [query.data, filters, keyword]);

  const allTags = useMemo(() => Array.from(new Set([
    ...tagNames, ...(query.data?.items ?? []).flatMap((task) => task.tags),
  ])).sort(), [tagNames, query.data]);

  return (
    <div className="cockpit-board" data-board="unified">
      <div className="board-filterbar" role="region" aria-label="All Tasks filters">
        <label className="board-search">
          <span className="visually-hidden">Search Tasks by title or path</span>
          <input type="search" data-search-input placeholder="Search tasks or project…"
            value={keyword} onChange={(event) => setKeyword(event.target.value)} />
        </label>
        <TaskFilters filters={filters} onChange={setFilters} tags={allTags} sections={sections} />
        <span className="board-result-count" aria-live="polite">{L2.taskCountText(rows.length)}</span>
        {keyword ? <button className="btn" type="button" onClick={() => setKeyword('')}>Clear search</button> : null}
      </div>
      {ignored ? <p className="notice-inline" role="status">{L2.filtersIgnored}</p> : null}
      {query.status === 'error' ? (
        <div className="error-bar" role="alert">
          <span>{L2.tasksLoadFailed}: {describeError(query.error)}</span>
          <button type="button" className="btn" onClick={() => void query.refetch()}>{L.retry}</button>
        </div>
      ) : null}
      {!query.data ? (
        query.status === 'error' ? null : <p className="muted" role="status">Loading Tasks…</p>
      ) : (
        <Kanban tasks={rows} queryKey={ALL_TASKS_KEY} today={today} />
      )}
    </div>
  );
}
