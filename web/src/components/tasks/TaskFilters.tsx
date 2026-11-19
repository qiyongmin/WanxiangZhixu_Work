import { useEffect, useId, useRef, useState } from 'react';
import { emptyFilters, hasActiveFilters, type TaskFilterState } from '../../lib/filters';
import { L2 } from '../../lib/labels';
import { PRIORITIES, STATUSES } from '../../lib/types';

export interface SectionOption {
  id: string;
  title: string;
}

interface Props {
  filters: TaskFilterState;
  onChange: (next: TaskFilterState) => void;
  tags: readonly string[];
  /** Used by My Tasks to filter across Sections. */
  sections?: readonly SectionOption[];
}

type FilterKey = 'status' | 'priority' | 'section' | 'tag' | 'due';

function toggle(list: readonly string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

/** Compact accessible multi-select popovers. All selections stay visible as a count.
 * Only one menu opens at once; existing TaskFilterState semantics are unchanged. */
export function TaskFilters({ filters, onChange, tags, sections }: Props) {
  const uid = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<FilterKey | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const set = (patch: Partial<TaskFilterState>) => onChange({ ...filters, ...patch });

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(null);
        root.current?.querySelector<HTMLButtonElement>(`[data-filter-trigger="${open}"]`)?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const menu = (
    key: FilterKey, label: string, selected: readonly string[],
    choices: ReadonlyArray<{ value: string; label: string }>,
    onToggle: (value: string) => void,
    empty?: string,
  ) => {
    const active = selected.length > 0;
    return (
      <div className="task-filter-menu" key={key} data-filter-key={key}>
        <button type="button" data-filter-trigger={key}
          className={active ? 'btn task-filter-trigger has-selection' : 'btn task-filter-trigger'}
          aria-expanded={open === key} aria-controls={`${uid}-${key}`}
          onClick={() => setOpen(open === key ? null : key)}>
          {label}{active ? <span className="task-filter-count">{selected.length}</span> : null}
          <span className="task-filter-chevron" aria-hidden="true">⌄</span>
        </button>
        {open === key ? (
          <fieldset id={`${uid}-${key}`} className="task-filter-popover filter-group">
            <legend className="visually-hidden">{label}</legend>
            {choices.length === 0 ? <span className="muted">{empty ?? 'No options'}</span> : null}
            {choices.map((option) => (
              <label className="check-row" key={option.value}>
                <input type="checkbox" checked={selected.includes(option.value)} onChange={() => onToggle(option.value)} />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
      </div>
    );
  };

  const hasDue = Boolean(filters.dueFrom || filters.dueTo);
  const selectedCount = filters.status.length + filters.priority.length + filters.tag.length + filters.section.length + (hasDue ? 1 : 0);
  return (
    <div className="task-filters task-filters-compact" role="group" aria-label={L2.filtersLabel} ref={root}
      data-mobile-expanded={mobileOpen ? 'true' : 'false'}>
      <button type="button" className="btn task-mobile-filter-toggle" aria-expanded={mobileOpen}
        onClick={() => { setMobileOpen((value) => !value); setOpen(null); }}>
        {L2.filtersLabel}{selectedCount ? <span className="task-filter-count">{selectedCount}</span> : null}
        <span aria-hidden="true">⌄</span>
      </button>
      <div className="task-filter-options">
      {menu('status', L2.filterStatus, filters.status,
        STATUSES.map((value) => ({ value, label: value })),
        (value) => set({ status: toggle(filters.status, value) }))}
      {menu('priority', L2.filterPriority, filters.priority,
        PRIORITIES.map((value) => ({ value, label: value })),
        (value) => set({ priority: toggle(filters.priority, value) }))}
      {sections ? menu('section', L2.filterSection, filters.section,
        sections.map((item) => ({ value: item.id, label: item.title })),
        (value) => set({ section: toggle(filters.section, value) })) : null}
      {menu('tag', L2.filterTag, filters.tag,
        tags.map((tag) => ({ value: tag, label: tag })),
        (value) => set({ tag: toggle(filters.tag, value) }), L2.filterNoTags)}
      <div className="task-filter-menu" data-filter-key="due">
        <button type="button" data-filter-trigger="due"
          className={hasDue ? 'btn task-filter-trigger has-selection' : 'btn task-filter-trigger'}
          aria-expanded={open === 'due'} aria-controls={`${uid}-due`}
          onClick={() => setOpen(open === 'due' ? null : 'due')}>
          {L2.due}{hasDue ? <span className="task-filter-count">1</span> : null}
          <span className="task-filter-chevron" aria-hidden="true">⌄</span>
        </button>
        {open === 'due' ? (
          <fieldset className="task-filter-popover task-filter-dates" id={`${uid}-due`}>
            <legend className="visually-hidden">{L2.due}</legend>
            <label htmlFor={`${uid}-from`}>{L2.filterDueFrom}</label>
            <input id={`${uid}-from`} type="date" value={filters.dueFrom}
              onChange={(event) => set({ dueFrom: event.target.value })} />
            <label htmlFor={`${uid}-to`}>{L2.filterDueTo}</label>
            <input id={`${uid}-to`} type="date" value={filters.dueTo}
              onChange={(event) => set({ dueTo: event.target.value })} />
            <button type="button" className="btn" onClick={() => { set({ dueFrom: '', dueTo: '' }); setOpen(null); }}>
              {L2.clearFilters}
            </button>
          </fieldset>
        ) : null}
      </div>
      {hasActiveFilters(filters) ? (
        <button type="button" className="btn task-filter-reset" onClick={() => { onChange(emptyFilters()); setOpen(null); }}>
          {L2.clearFilters}
        </button>
      ) : null}
      </div>
    </div>
  );
}
