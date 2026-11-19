import { useId, useState, type FormEvent } from 'react';
import { describeError } from '../../lib/errors';
import { L, L2, L4 } from '../../lib/labels';
import { openCreate } from '../../lib/ui';
import { Icon } from '../icons';
import {
  afterSectionWrite,
  describeSectionError,
  fetchSections,
  movedOrder,
  ruleViolations,
  sectionApi,
  titleProblem,
} from '../../lib/phase4';
import { useQuery } from '../../lib/queryCache';
import type { RuleViolation, SectionAdminItem } from '../../lib/types';
import { AppLink } from '../AppLink';
import { useAnnounce } from '../announce';

interface RowProps {
  section: SectionAdminItem;
  index: number;
  total: number;
  busy: boolean;
  violations: RuleViolation[] | null;
  onMove: (index: number, delta: -1 | 1) => void;
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (id: string) => void;
  onRule: (id: string, enabled: boolean) => void;
  error: string | null;
}

function SectionRow({ section, index, total, busy, violations, onMove, onRename, onDelete, onRule, error }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.title);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const inputId = useId();
  const enabled = section.rules.departmentSummaryOnly === true;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const issue = titleProblem(draft);
    setProblem(issue);
    if (issue) return;
    if (await onRename(section.id, draft)) setEditing(false);
  };

  return (
    <li className="section-row" data-section-id={section.id}>
      <div className="section-main">
        <span className="section-position" aria-label={L4.sectionPosition}>
          {section.sortOrder}
        </span>
        {editing ? (
          <form className="section-edit" onSubmit={(event) => void save(event)}>
            <label htmlFor={inputId} className="visually-hidden">
              {L4.sectionRename}
            </label>
            <input
              id={inputId}
              className="input"
              value={draft}
              aria-invalid={problem ? true : undefined}
              data-autofocus
              onChange={(event) => setDraft(event.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {L4.sectionSave}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setEditing(false);
                setDraft(section.title);
                setProblem(null);
              }}
            >
              {L4.sectionCancel}
            </button>
          </form>
        ) : (
          <strong className="section-title">{section.title}</strong>
        )}
        <span className="muted">
          {L4.sectionNodes}: {section.nodeCount}
        </span>
      </div>
      <div className="section-actions">
        <button
          type="button"
          className="btn"
          disabled={busy || index === 0}
          aria-label={`${L4.sectionMoveUp}: ${section.title}`}
          onClick={() => onMove(index, -1)}
        >
          {L4.sectionMoveUp}
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || index === total - 1}
          aria-label={`${L4.sectionMoveDown}: ${section.title}`}
          onClick={() => onMove(index, 1)}
        >
          {L4.sectionMoveDown}
        </button>
        {!editing ? (
          <button
            type="button"
            className="btn"
            aria-label={`${L4.sectionRename}: ${section.title}`}
            onClick={() => setEditing(true)}
          >
            {L4.sectionRename}
          </button>
        ) : null}
        {confirming ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            aria-label={`${L4.sectionDeleteConfirm}: ${section.title}`}
            onClick={() => {
              setConfirming(false);
              onDelete(section.id);
            }}
          >
            {L4.sectionDeleteConfirm}
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy}
            aria-label={`${L4.sectionDelete}: ${section.title}`}
            onClick={() => setConfirming(true)}
          >
            {L4.sectionDelete}
          </button>
        )}
        <label className="switch-row">
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            disabled={busy}
            aria-label={`${L4.sectionRuleLabel}: ${section.title}`}
            onChange={(event) => onRule(section.id, event.target.checked)}
          />
          <span>{enabled ? L4.ruleOn : L4.ruleOff}</span>
        </label>
      </div>
      {problem ? (
        <p className="error-text" role="alert">
          {problem}
        </p>
      ) : null}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {violations && violations.length > 0 ? (
        <div className="rule-violations" role="alert">
          <p className="error-text">{L4.ruleViolationsTitle}</p>
          <table className="agent-table">
            <thead>
              <tr>
                <th scope="col">{L4.ruleViolationNode}</th>
                <th scope="col">{L4.ruleViolationField}</th>
              </tr>
            </thead>
            <tbody>
              {violations.map((item) => (
                <tr key={`${item.nodeId}:${item.field}`}>
                  <td>
                    <code>{item.nodePath}</code>
                  </td>
                  <td>
                    <code>{item.field}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </li>
  );
}

/** 设置 → Section 管理（`/settings/sections`）。 */
export function SectionsAdmin() {
  const announce = useAnnounce();
  const query = useQuery<SectionAdminItem[]>('sections', fetchSections, { staleMs: 0 });
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [violations, setViolations] = useState<{ id: string; items: RuleViolation[] } | null>(null);
  const sections = (query.data ?? []).filter((item) => item.virtual !== true);

  const run = async (id: string | null, action: () => Promise<unknown>, done: string): Promise<boolean> => {
    setBusy(true);
    setRowError(null);
    setViolations(null);
    try {
      await action();
      afterSectionWrite();
      announce(done);
      return true;
    } catch (error) {
      const found = ruleViolations(error);
      if (found && id) setViolations({ id, items: found });
      else if (id) setRowError({ id, text: describeSectionError(error) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const move = (index: number, delta: -1 | 1) => {
    const order = movedOrder(
      sections.map((item) => item.id),
      index,
      delta,
    );
    const target = sections[index];
    if (order && target) void run(target.id, () => sectionApi.reorder(order), L4.sectionSaved);
  };

  return (
    <section className="page" aria-labelledby="page-title">
      <p>
        <AppLink to="/settings">{L4.sectionsBack}</AppLink>
      </p>
      <div className="section-head">
        <h1 id="page-title">{L4.sectionsTitle}</h1>
        <button
          type="button"
          className="btn btn-icon"
          aria-label={L2.newSection}
          title={L2.newSection}
          onClick={() => openCreate('section')}
        >
          <Icon name="plus" />
        </button>
      </div>
      {query.status === 'error' && !query.data ? (
        <div role="alert" className="error-bar">
          <span>
            {L4.sectionsLoadFailed}: {describeError(query.error)}
          </span>
          <button type="button" className="btn" onClick={() => void query.refetch()}>
            {L.retry}
          </button>
        </div>
      ) : null}
      {!query.data && query.status !== 'error' ? <p className="muted">{L.loading}</p> : null}
      <ol className="section-list" aria-label={L4.sectionsList}>
        {sections.map((section, index) => (
          <SectionRow
            key={section.id}
            section={section}
            index={index}
            total={sections.length}
            busy={busy}
            violations={violations?.id === section.id ? violations.items : null}
            error={rowError?.id === section.id ? rowError.text : null}
            onMove={move}
            onRename={(id, next) => run(id, () => sectionApi.rename(id, next), L4.sectionSaved)}
            onDelete={(id) => void run(id, () => sectionApi.remove(id), L4.sectionDeleted)}
            onRule={(id, enabled) => void run(id, () => sectionApi.setRule(id, enabled), L4.sectionSaved)}
          />
        ))}
      </ol>
    </section>
  );
}
