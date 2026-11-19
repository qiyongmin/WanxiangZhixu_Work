// 任务过滤纯函数：与 tools/work_hub_nodes.py 的 task_matches / sort_task_rows 语义一致，
// 并与 Python 共用 tests/fixtures/task_filter_vectors.json 黄金用例（Property 19）。
// 同一维度取并集，不同维度取交集；设置 Due_Date 范围时无 Due_Date 的 Task 被排除；边界含起止日期。
import type { TaskRow } from './types';

export interface TaskFilterState {
  status: string[];
  priority: string[];
  tag: string[];
  section: string[];
  dueFrom: string;
  dueTo: string;
}

/** 参与过滤的最小字段集合（黄金用例的行只有这些字段）。 */
export type FilterableRow = Pick<TaskRow, 'status' | 'priority' | 'dueDate' | 'tags'> & { sectionId: string | null };

export function emptyFilters(): TaskFilterState {
  return { status: [], priority: [], tag: [], section: [], dueFrom: '', dueTo: '' };
}

export function hasActiveFilters(filters: TaskFilterState): boolean {
  return (
    filters.status.length > 0 ||
    filters.priority.length > 0 ||
    filters.tag.length > 0 ||
    filters.section.length > 0 ||
    filters.dueFrom !== '' ||
    filters.dueTo !== ''
  );
}

/** 接受黄金用例里的部分过滤对象（缺省维度 = 未设置）。 */
export function normalizeFilters(raw: Partial<TaskFilterState> | undefined): TaskFilterState {
  const base = emptyFilters();
  if (!raw) return base;
  return {
    status: raw.status ?? base.status,
    priority: raw.priority ?? base.priority,
    tag: raw.tag ?? base.tag,
    section: raw.section ?? base.section,
    dueFrom: raw.dueFrom ?? '',
    dueTo: raw.dueTo ?? '',
  };
}

export function taskMatches(row: FilterableRow, filters: TaskFilterState): boolean {
  if (filters.status.length > 0 && !filters.status.includes(row.status)) return false;
  if (filters.priority.length > 0 && (row.priority === null || !filters.priority.includes(row.priority))) return false;
  if (filters.tag.length > 0 && !row.tags.some((tag) => filters.tag.includes(tag))) return false;
  if (filters.section.length > 0 && (row.sectionId === null || !filters.section.includes(row.sectionId))) return false;
  if (filters.dueFrom !== '' || filters.dueTo !== '') {
    const due = row.dueDate;
    if (!due) return false;
    if (filters.dueFrom !== '' && due < filters.dueFrom) return false;
    if (filters.dueTo !== '' && due > filters.dueTo) return false;
  }
  return true;
}

export function filterTasks<T extends FilterableRow>(rows: readonly T[], filters: TaskFilterState): T[] {
  return hasActiveFilters(filters) ? rows.filter((row) => taskMatches(row, filters)) : [...rows];
}

/** Due_Date 升序（无日期在后），再 updatedAt 降序，再 id 升序（与服务端排序一致）。 */
export function sortTasks<T extends Pick<TaskRow, 'id' | 'dueDate' | 'updatedAt'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if ((a.dueDate === null) !== (b.dueDate === null)) return a.dueDate === null ? 1 : -1;
    if (a.dueDate !== b.dueDate) return (a.dueDate ?? '') < (b.dueDate ?? '') ? -1 : 1;
    const au = a.updatedAt ?? '';
    const bu = b.updatedAt ?? '';
    if (au !== bu) return au < bu ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 去掉已不存在的 Section / Tag；返回清洗后的过滤条件与是否忽略了条件（Req 15.8）。 */
export function dropStaleFilters(
  filters: TaskFilterState,
  sectionIds: ReadonlySet<string>,
  tags: ReadonlySet<string>,
): { filters: TaskFilterState; ignored: boolean } {
  const section = filters.section.filter((id) => sectionIds.has(id));
  const tag = filters.tag.filter((name) => tags.has(name));
  const ignored = section.length !== filters.section.length || tag.length !== filters.tag.length;
  return { filters: { ...filters, section, tag }, ignored };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STRINGS = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '')
    ? Array.from(new Set(value as string[]))
    : undefined;

/** `kbw:v1:mytasks-filters` 校验器：任何字段非法则整体视为非法（回退为空过滤）。 */
export function validateFilterState(value: unknown): TaskFilterState | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const sections = STRINGS(raw.sections);
  const priorities = STRINGS(raw.priorities);
  const statuses = STRINGS(raw.statuses);
  const tags = STRINGS(raw.tags);
  const dueFrom = raw.dueFrom;
  const dueTo = raw.dueTo;
  if (!sections || !priorities || !statuses || !tags) return undefined;
  if (typeof dueFrom !== 'string' || typeof dueTo !== 'string') return undefined;
  if ((dueFrom !== '' && !DAY.test(dueFrom)) || (dueTo !== '' && !DAY.test(dueTo))) return undefined;
  return { section: sections, priority: priorities, status: statuses, tag: tags, dueFrom, dueTo };
}

export function serializeFilterState(filters: TaskFilterState): Record<string, unknown> {
  return {
    sections: filters.section,
    priorities: filters.priority,
    statuses: filters.status,
    tags: filters.tag,
    dueFrom: filters.dueFrom,
    dueTo: filters.dueTo,
  };
}
