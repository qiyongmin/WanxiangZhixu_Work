import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError } from '../../lib/api';
import { notifyDraftChange, registerEditor } from '../../lib/draftGuard';
import { describeError } from '../../lib/errors';
import {
  buildChanges,
  conflictDiff,
  draftFromNode,
  isDirty,
  validateDraft,
  type InspectorDraft,
} from '../../lib/inspector';
import { L, L2 } from '../../lib/labels';
import { isConflict } from '../../lib/nodeData';
import { fieldReasons } from '../../lib/nodeForm';
import { updateNode } from '../../lib/taskWrite';
import { PRIORITIES, STATUSES, type CurrentNodeView, type NodeDTO, type Status } from '../../lib/types';
import { useAnnounce } from '../announce';
import { ReminderActions } from '../ReminderActions';
import { LinksEditor } from './LinksEditor';
import { RecurrenceEditor } from './RecurrenceEditor';
import { TagEditor } from './TagEditor';
import { TaskExtras } from './TaskExtras';

interface Conflict {
  revision: number;
  current: CurrentNodeView | undefined;
}

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'failed'; message: string };

export function isTaskKind(kind: NodeDTO['kind']): boolean {
  return kind === 'task' || kind === 'action';
}

/**
 * 右栏属性检查器：所有 Section 与层级使用相同的字段集合和顺序——
 * Status、Priority、Due_Date、Remind_At、Repeat_Rule、Tag、Typed_Link（及 Back_Reference）。
 * 表单式「草稿 + 保存」：一次 node-update（一条 Revision）；冲突/校验失败保留草稿。
 */
export function Inspector({ node, hideCore = false }: { node: NodeDTO; hideCore?: boolean }) {
  const announce = useAnnounce();
  const uid = useId();
  const task = isTaskKind(node.kind);
  const [base, setBase] = useState<InspectorDraft>(() => draftFromNode(node));
  const [draft, setDraft] = useState<InspectorDraft>(() => draftFromNode(node));
  const [baseRevision, setBaseRevision] = useState(node.revision);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const baseRef = useRef(base);
  baseRef.current = base;
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => registerEditor(`inspector:${node.id}`, {
    dirty: () => isDirty(draftRef.current, baseRef.current),
    save: () => saveRef.current(),
    discard: () => { setDraft(baseRef.current); draftRef.current = baseRef.current; },
  }), [node.id]);
  useEffect(() => notifyDraftChange(), [draft, base]);

  // 节点在外部更新后：草稿没有改动就跟随最新值；有改动则保留草稿（冲突在保存时处理）。
  useEffect(() => {
    if (isDirty(draftRef.current, baseRef.current)) return;
    const fresh = draftFromNode(node);
    setBase(fresh);
    setDraft(fresh);
    setBaseRevision(node.revision);
    setConflict(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.revision, node.priority, node.dueDate, node.remindAt, node.status, node.tags.join('\u0000'), JSON.stringify(node.repeat)]);

  const set = (patch: Partial<InspectorDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setState((current) => (current.kind === 'saved' ? { kind: 'idle' } : current));
  };

  const save = async (revision: number): Promise<boolean> => {
    const changes = buildChanges(draft, base);
    if (Object.keys(changes).length === 0) {
      setState({ kind: 'failed', message: L2.unchanged });
      return true;
    }
    const problems = validateDraft(draft, task);
    setErrors(problems);
    if (Object.keys(problems).length > 0) {
      setState({ kind: 'failed', message: L2.saveFailedFields });
      announce(L2.saveFailedFields);
      return false;
    }
    setState({ kind: 'saving' });
    try {
      const result = await updateNode(node.id, revision, changes);
      const fresh = draftFromNode(result.node);
      setBase(fresh);
      setDraft(fresh);
      setBaseRevision(result.node.revision);
      setConflict(null);
      setErrors({});
      setState({ kind: 'saved' });
      announce(L.saved);
      return true;
    } catch (failure) {
      if (isConflict(failure)) {
        const latest = failure.currentRevision ?? failure.current?.revision ?? revision;
        setConflict({ revision: latest, current: failure.current });
        setState({ kind: 'failed', message: `${L.conflictTitle}: ${L.draftKept}` });
        announce(`${L.conflictTitle}, ${L.draftKept}`);
      } else if (failure instanceof ApiError && failure.status === 400) {
        setErrors(fieldReasons(failure));
        setState({ kind: 'failed', message: L2.saveFailedFields });
        announce(`${L.saveFailed}: ${failure.message}`);
      } else {
        const message = `${L.saveFailed}: ${describeError(failure)}. ${L.draftKept}`;
        setState({ kind: 'failed', message });
        announce(message);
      }
      return false;
    }
  };

  saveRef.current = () => save(baseRevision);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (state.kind === 'saving') return;
    void save(baseRevision);
  };

  const diff = conflict ? conflictDiff(draft, base, conflict.current) : null;
  const dirty = isDirty(draft, base);

  return (
    <div className="inspector" data-node-id={node.id}>
      <form className="inspector-form" aria-label={L2.inspectorFormLabel} onSubmit={onSubmit} noValidate>
        {!hideCore ? <>
        <div className="field" data-field="status">
          <label htmlFor={`${uid}-status`}>{L.fieldStatus}</label>
          <select
            id={`${uid}-status`}
            value={draft.status}
            aria-invalid={errors.status ? true : undefined}
            onChange={(event) => set({ status: event.target.value as Status })}
          >
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          {errors.status ? <p className="field-error error-text">{errors.status}</p> : null}
        </div>
        <div className="field" data-field="priority">
          <label htmlFor={`${uid}-priority`}>{L2.fieldPriority}</label>
          <select
            id={`${uid}-priority`}
            value={draft.priority}
            aria-invalid={errors.priority ? true : undefined}
            onChange={(event) => set({ priority: event.target.value })}
          >
            {draft.priority === '' ? <option value="">{L2.noPriority}</option> : null}
            {PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          {errors.priority ? <p className="field-error error-text">{errors.priority}</p> : null}
        </div>
        <div className="field" data-field="dueDate">
          <label htmlFor={`${uid}-due`}>{L2.fieldDue}</label>
          <div className="inline-add">
            <input
              id={`${uid}-due`}
              type="date"
              value={draft.dueDate}
              aria-invalid={errors.dueDate ? true : undefined}
              onChange={(event) => set({ dueDate: event.target.value })}
            />
            {draft.dueDate !== '' ? (
              <button type="button" className="btn" onClick={() => set({ dueDate: '' })}>
                {L2.clear}
              </button>
            ) : null}
          </div>
          {errors.dueDate ? <p className="field-error error-text">{errors.dueDate}</p> : null}
        </div>
        </> : null}
        {(task || !hideCore) ? <>
        <div className="field" data-field="remindAt">
          <label htmlFor={`${uid}-remind`}>{L2.fieldRemind}</label>
          <div className="inline-add">
            <input
              id={`${uid}-remind`}
              type="datetime-local"
              value={draft.remindAt}
              disabled={!task}
              aria-invalid={errors.remindAt ? true : undefined}
              onChange={(event) => set({ remindAt: event.target.value })}
            />
            {task && draft.remindAt !== '' ? (
              <button type="button" className="btn" onClick={() => set({ remindAt: '' })}>
                {L2.clear}
              </button>
            ) : null}
          </div>
          {!task ? <p className="muted">{L2.taskOnly}</p> : null}
          {errors.remindAt ? <p className="field-error error-text">{errors.remindAt}</p> : null}
          {task && node.remindPending && node.remindAt ? (
            <ReminderActions taskId={node.id} remindAt={node.remindAt} revision={node.revision} />
          ) : null}
        </div>
        <div className="field" data-field="repeat">
          <span className="field-label" id={`${uid}-repeat`}>
            {L2.fieldRepeat}
          </span>
          <RecurrenceEditor
            value={draft.repeat}
            onChange={(repeat) => set({ repeat })}
            disabled={!task}
            error={errors.repeat}
          />
          {!task ? <p className="muted">{L2.taskOnly}</p> : null}
        </div>
        </> : null}
        <div className="field" data-field="tags">
          <span className="field-label">{L2.fieldTags}</span>
          <TagEditor tags={draft.tags} onChange={(tags) => set({ tags })} error={errors.tags} />
        </div>
        {conflict ? (
          <div className="conflict" role="alert">
            <strong>{L.conflictTitle}</strong>
            <p>
              {L2.conflictBodyInspector} {L.conflictRevision} {conflict.revision}
            </p>
            {diff ? (
              <p>
                {L.fieldStatus}: {L.conflictMine} {diff.mine} / {L.conflictCurrent} {diff.current}
              </p>
            ) : null}
            <button type="button" className="btn" onClick={() => void save(conflict.revision)}>
              {L.conflictResave}
            </button>
          </div>
        ) : null}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={state.kind === 'saving' || !dirty}>
            {state.kind === 'saving' ? L.saving : L2.inspectorSave}
          </button>
          <p role="status" aria-live="polite" className={state.kind === 'failed' ? 'error-text save-status' : 'save-status'}>
            {state.kind === 'saved' ? L.saved : state.kind === 'failed' ? state.message : ''}
          </p>
        </div>
      </form>
      {task ? <TaskExtras key={node.id} node={node} /> : null}
      <div className="field" data-field="links">
        <span className="field-label">{L2.fieldLinks}</span>
        <LinksEditor node={node} />
      </div>
    </div>
  );
}
