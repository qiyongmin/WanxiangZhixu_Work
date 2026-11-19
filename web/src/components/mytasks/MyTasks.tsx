import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../../lib/api';
import { ALL_TASKS_KEY, useAllTasks } from '../../lib/allTasks';
import {
  dropStaleFilters,
  emptyFilters,
  serializeFilterState,
  validateFilterState,
  type TaskFilterState,
} from '../../lib/filters';
import { displaySectionTitle, L2 } from '../../lib/labels';
import { useQuery } from '../../lib/queryCache';
import { KEYS, readJson, writeJson } from '../../lib/storage';
import type { TagCount, TreeView } from '../../lib/types';
import { openQuickAdd } from '../../lib/ui';
import { Icon } from '../icons';
import type { SectionOption } from '../tasks/TaskFilters';
import { TasksBrowser, useTasksViewState } from '../tasks/TasksBrowser';
import { useTaskMover } from '../tasks/useTaskMover';

export const MY_TASKS_KEY = ALL_TASKS_KEY;

/** My_Tasks：所有 Section 的 Task，过滤持久化到 `kbw:v1:mytasks-filters`，失效引用被忽略并提示。 */
export function MyTasks() {
  const [state, update] = useTasksViewState();
  const [filters, setFiltersState] = useState<TaskFilterState>(() =>
    readJson(KEYS.mytasksFilters, (value) => validateFilterState(value) ?? undefined, emptyFilters()),
  );
  const [ignored, setIgnored] = useState(false);
  const checked = useRef(false);

  const query = useAllTasks();
  const tree = useQuery<TreeView>('tree', (signal) => get<TreeView>('tree', {}, { signal }));
  const tags = useQuery<TagCount[]>('tags', (signal) => get<TagCount[]>('tags', {}, { signal }));
  const { move, dialog } = useTaskMover(MY_TASKS_KEY);

  const sections = useMemo<SectionOption[]>(() => {
    const used = new Set(tree.data?.nodes.map((node) => node.sectionId));
    return (tree.data?.sections ?? [])
      .filter((section) => !section.virtual || used.has(section.id))
      .map((section) => ({ id: section.id, title: displaySectionTitle(section.title) }));
  }, [tree.data]);
  const tagNames = useMemo(() => (tags.data ?? []).map((item) => item.tag), [tags.data]);

  // 加载后只校验一次：引用了不存在的 Section/Tag 时忽略该条件，保留其余有效条件。
  useEffect(() => {
    if (checked.current || !tree.data || !tags.data) return;
    checked.current = true;
    const result = dropStaleFilters(filters, new Set(tree.data.sections.map((s) => s.id)), new Set(tagNames));
    if (result.ignored) {
      setIgnored(true);
      setFiltersState(result.filters);
      writeJson(KEYS.mytasksFilters, serializeFilterState(result.filters));
    }
  }, [tree.data, tags.data, tagNames, filters]);

  const setFilters = useCallback((next: TaskFilterState) => {
    setFiltersState(next);
    setIgnored(false);
    writeJson(KEYS.mytasksFilters, serializeFilterState(next));
  }, []);

  return (
    <section className="page" aria-labelledby="page-title">
      <div className="section-head">
        <h1 id="page-title">{L2.myTasksTitle}</h1>
        <button
          type="button"
          className="btn btn-icon btn-primary"
          aria-label={L2.newTask}
          title={L2.newTask}
          onClick={() => openQuickAdd()}
        >
          <Icon name="plus" />
        </button>
      </div>
      <TasksBrowser
        query={query}
        queryKey={MY_TASKS_KEY}
        filters={filters}
        onFiltersChange={setFilters}
        view={state.view}
        onViewChange={(view) => update({ view })}
        sections={sections}
        extraTags={tagNames}
        onStatusChange={(task, to) => void move(task, to)}
        banner={
          ignored ? (
            <p role="status" className="notice-inline">
              {L2.filtersIgnored}
            </p>
          ) : null
        }
      />
      {dialog}
    </section>
  );
}
