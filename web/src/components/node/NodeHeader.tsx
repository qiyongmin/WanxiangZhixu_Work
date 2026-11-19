import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, post } from '../../lib/api';
import { notifyDraftChange, registerEditor } from '../../lib/draftGuard';
import { describeError } from '../../lib/errors';
import { L } from '../../lib/labels';
import { afterWrite, isConflict } from '../../lib/nodeData';
import { navigate, nodePath } from '../../lib/router';
import {
  canHaveChild,
  changesFrom,
  diffAgainstCurrent,
  draftOf,
  fieldReasons,
  type Draft,
  type FieldDiff,
} from '../../lib/nodeForm';
import {
  type CurrentNodeView,
  type NodeDTO,
  type NodeResult,
  type UnconfirmedWrite,
} from '../../lib/types';
import { openChildAdd } from '../../lib/ui';
import { useAnnounce } from '../announce';
import { UnconfirmedControls } from '../agent/UnconfirmedMark';
import { Icon } from '../icons';
import { IconMenu } from '../Menu';
import { InlineProperties } from './InlineProperties';
import { Inspector } from '../inspector/Inspector';
import { OverlayDialog } from '../OverlayDialog';

interface Origin {
  revision: number;
  values: Draft;
}

interface Conflict {
  current: CurrentNodeView;
  revision: number;
}

interface Props {
  node: NodeDTO;
  /** 删除成功后由上层展示「已删除 / 恢复」。 */
  onDeleted: (node: NodeDTO) => void;
  hideDescription?: boolean;
}

const FIELD_LABELS: Record<FieldDiff['field'], string> = {
  title: L.fieldTitle,
  status: L.fieldStatus,
  description: L.fieldDescription,
};

/** 标题区：标题、Status、编辑表单、冲突处理与归档/删除。结构对所有节点类型一致。 */
export function NodeHeader({ node, onDeleted, hideDescription = false }: Props) {
  const announce = useAnnounce();
  const uid = useId();
  const [editing, setEditing] = useState(false);
  const [detailsOpen,setDetailsOpen]=useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(node));
  const origin = useRef<Origin>({ revision: node.revision, values: draftOf(node) });
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | null>(null);
  const canAddChild = canHaveChild(node.depth) && !node.archivedAt;
  const childLabel = node.kind === 'initiative' || node.kind === 'knowledge_collection'
    ? 'Add Workstream or Task'
    : node.kind === 'topic' ? 'Add Campaign or Task' : L.newChild;
  const dirtyRef = useRef(false);
  dirtyRef.current = editing && Object.keys(changesFrom(draft, origin.current.values)).length > 0;
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => registerEditor(`node-header:${node.id}`, {
    dirty: () => dirtyRef.current,
    save: () => saveRef.current(),
    discard: () => { dirtyRef.current = false; setEditing(false); setDraft(origin.current.values); },
  }), [node.id]);
  useEffect(() => notifyDraftChange(), [draft, editing]);

  const startEdit = () => {
    origin.current = { revision: node.revision, values: draftOf(node) };
    setDraft(draftOf(node));
    setFieldErrors({});
    setFailure(null);
    setConflict(null);
    setEditing(true);
  };

  const closeEdit = () => {
    setEditing(false);
    setConflict(null);
    setFieldErrors({});
    setFailure(null);
    window.setTimeout(() => document.getElementById(`${uid}-more`)?.focus(), 0);
  };

  const submit = async (event?: FormEvent, override?: Draft): Promise<boolean> => {
    event?.preventDefault();
    if (saving) return false;
    const values = override ?? draft;
    if (values.title.trim() === '') {
      setFieldErrors({ title: L.createTitleRequired });
      return false;
    }
    const changes = changesFrom(values, origin.current.values);
    if (Object.keys(changes).length === 0) {
      closeEdit();
      dirtyRef.current = false;
      return true;
    }
    setSaving(true);
    setFieldErrors({});
    setFailure(null);
    try {
      const result = await post<NodeResult>('node-update', {
        id: node.id,
        baseRevision: origin.current.revision,
        changes,
      });
      afterWrite(result.node);
      announce(L.saved);
      dirtyRef.current = false;
      closeEdit();
      notifyDraftChange();
      return true;
    } catch (error) {
      if (isConflict(error) && error.current) {
        setConflict({ current: error.current, revision: error.currentRevision ?? error.current.revision });
        announce(`${L.conflictTitle}, ${L.draftKept}`);
      } else if (error instanceof ApiError && error.status === 400 && error.fields.length > 0) {
        setFieldErrors(fieldReasons(error));
        announce(`${L.saveFailed}: ${error.message}`);
      } else {
        const message = describeError(error);
        setFailure(`${L.saveFailed}: ${message}. ${L.draftKept}`);
        announce(`${L.saveFailed}: ${message}`);
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  saveRef.current = () => submit();

  /** 以当前版本为基础重新保存：基线与 Revision 换成冲突响应里的 current。 */
  const resave = () => {
    if (!conflict) return;
    // 只重放用户自己改过的字段，避免覆盖对方改动而用户未触碰的字段。
    const touched = changesFrom(draft, origin.current.values);
    const currentValues: Draft = {
      title: conflict.current.title,
      status: conflict.current.status,
      description: conflict.current.description,
    };
    const replay = changesFrom({ ...currentValues, ...touched }, currentValues);
    origin.current = { revision: conflict.revision, values: currentValues };
    const next: Draft = { ...currentValues, ...replay };
    setDraft(next);
    setConflict(null);
    if (Object.keys(replay).length === 0) {
      announce(L.conflictNoDiff);
      closeEdit();
      return;
    }
    void submit(undefined, next);
  };

  const lifecycle = async (operation: 'archive' | 'unarchive' | 'delete') => {
    if (busy) return;
    setBusy(true);
    setOpError(null);
    try {
      const result = await post<NodeResult>('node-lifecycle', {
        id: node.id,
        baseRevision: node.revision,
        operation,
      });
      setConfirmDelete(false);
      if (operation === 'delete') {
        announce(L.deleted);
        afterWrite(result.node);
        onDeleted(result.node);
      } else {
        afterWrite(result.node);
        announce(operation === 'archive' ? L.archivedDone : L.unarchivedDone);
      }
    } catch (error) {
      const message = isConflict(error) ? L.conflictBody : describeError(error);
      setOpError(`${L.opFailed}: ${message}`);
      announce(`${L.opFailed}: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  const diffs = conflict
    ? diffAgainstCurrent(draft, conflict.current)
    : [];
  const titleId = `${uid}-title`;
  const descId = `${uid}-desc`;

  return (
    <header className="node-header">
      <div className="node-title-row">
        <h1 id="page-title" className="node-title">
          {node.title}
        </h1>
        <InlineProperties key={node.id} node={node}/>
        <span className="muted node-kind">{node.displayKind}</span>
        {(node.unconfirmed as unknown as UnconfirmedWrite[])
          .filter((item) => item.op === 'add_task')
          .map((item) => (
            <UnconfirmedControls key={item.writeId} writeId={item.writeId} subject={node.title} />
          ))}
        {!editing ? (
          <span className="node-actions">
            {canAddChild ? <button
              type="button"
              className={node.depth === 2 ? 'btn node-new-task-action' : 'btn btn-icon'}
              aria-label={childLabel}
              title={node.depth===2 ? 'Create a new Task in this Workstream' : childLabel}
              onClick={() => openChildAdd(node.id, node.kind)}
            >
              <Icon name="plus" size={16}/>
              {node.depth===2 ? <span>New Task</span> : null}
            </button> : null}
            <IconMenu
              label={L.nodeActions}
              icon={node.depth===2||node.depth===3?'settings':'more'}
              align="end"
              className={node.depth===2||node.depth===3?'node-action-menu':undefined}
              triggerId={`${uid}-more`}
              items={[
                { key: 'edit', label: L.edit, icon: 'edit', onSelect: startEdit },
                ...(node.depth<=3 ?
                  [{key:'additional-details',label:'Additional Details',icon:'settings' as const,onSelect:()=>setDetailsOpen(true)}] : []),
                ...((node.depth===2||node.depth===3)&&['workstream','campaign','task','action'].includes(node.kind) ?
                  [{key:'activity',label:'Activity / Revision history',icon:'history' as const,
                    onSelect:()=>navigate(nodePath(node.id,'activity'))}] : []),
                node.archivedAt
                  ? { key: 'unarchive', label: L.unarchive, icon: 'archive', disabled: busy, onSelect: () => void lifecycle('unarchive') }
                  : { key: 'archive', label: L.archive, icon: 'archive', disabled: busy, onSelect: () => void lifecycle('archive') },
                { key: 'delete', label: L.delete, icon: 'trash', danger: true, disabled: busy, onSelect: () => setConfirmDelete(true) },
              ]}
            >
              {node.depth===2||node.depth===3 ? <><span className="node-action-menu-label">Actions</span>
                <Icon name="chevron-down" size={13}/></> : null}
            </IconMenu>
          </span>
        ) : null}
      </div>
      {detailsOpen ? <OverlayDialog title="Additional Details" onClose={()=>setDetailsOpen(false)}
        className="work-details-dialog"><Inspector node={node} hideCore/></OverlayDialog> : null}
      {node.archivedAt ? (
        <p className="banner" role="status">
          {L.archivedBanner}
        </p>
      ) : null}
      {node.description && !editing && !hideDescription ? <p className="node-description">{node.description}</p> : null}

      {!editing && confirmDelete ? (
        <div className="inline-confirm" role="group" aria-label={L.deleteAsk}>
          <span>{L.deleteAsk}</span>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void lifecycle('delete')}>
            {L.deleteConfirm}
          </button>
          <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
            {L.cancel}
          </button>
        </div>
      ) : null}
      {opError ? (
        <p role="alert" className="error-text">
          {opError}
        </p>
      ) : null}

      {editing ? (
        <form className="form" aria-label={L.editTitle} onSubmit={(event) => void submit(event)} noValidate>
          <div className="field">
            <label htmlFor={titleId}>{L.fieldTitle}</label>
            <input
              id={titleId}
              type="text"
              value={draft.title}
              aria-invalid={fieldErrors.title ? true : undefined}
              aria-describedby={fieldErrors.title ? `${titleId}-err` : undefined}
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
              autoFocus
            />
            {fieldErrors.title ? (
              <p id={`${titleId}-err`} className="field-error error-text">
                {fieldErrors.title}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor={descId}>{L.fieldDescription}</label>
            <textarea
              id={descId}
              rows={4}
              value={draft.description}
              aria-invalid={fieldErrors.description ? true : undefined}
              aria-describedby={fieldErrors.description ? `${descId}-err` : undefined}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })}
            />
            {fieldErrors.description ? (
              <p id={`${descId}-err`} className="field-error error-text">
                {fieldErrors.description}
              </p>
            ) : null}
          </div>

          {failure ? (
            <p role="alert" className="error-text">
              {failure}
            </p>
          ) : null}

          {conflict ? (
            <section className="conflict" role="alert" aria-label={L.conflictTitle}>
              <h2>{L.conflictTitle}</h2>
              <p>
                {L.conflictBody} {L.conflictRevision}: <strong data-testid="conflict-revision">{conflict.revision}</strong>
              </p>
              {diffs.length === 0 ? (
                <p>{L.conflictNoDiff}</p>
              ) : (
                <table className="diff-table">
                  <thead>
                    <tr>
                      <th scope="col">{L.fieldTitle}</th>
                      <th scope="col">{L.conflictMine}</th>
                      <th scope="col">{L.conflictCurrent}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.map((diff) => (
                      <tr key={diff.field} data-field={diff.field}>
                        <th scope="row">{FIELD_LABELS[diff.field]}</th>
                        <td>{diff.mine}</td>
                        <td>{diff.current}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <button type="button" className="btn btn-primary" onClick={resave} disabled={saving}>
                {L.conflictResave}
              </button>
            </section>
          ) : null}

          <div className="form-actions">
            <button type="submit" className="btn btn-primary" disabled={saving || conflict !== null}>
              {saving ? L.saving : L.save}
            </button>
            <button type="button" className="btn" onClick={closeEdit}>
              {conflict ? L.discardDraft : L.cancel}
            </button>
          </div>
        </form>
      ) : null}
    </header>
  );
}
