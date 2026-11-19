import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { ApiError, get, post } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { L, L2 } from '../../lib/labels';
import { afterWrite } from '../../lib/nodeData';
import { fieldReasons, parentChoices } from '../../lib/nodeForm';
import { useQuery } from '../../lib/queryCache';
import { navigate, nodePath, useRoute } from '../../lib/router';
import type { NodeResult, TreeNode, TreeView } from '../../lib/types';
import { closeQuickAdd, useUi } from '../../lib/ui';
import { useAnnounce } from '../announce';
import { ModalDialog } from '../ModalDialog';

export const TITLE_MIN = 1;
export const TITLE_MAX = 200;

/** 标题去除首尾空白后的长度必须为 1–200（按 Unicode 码点）。 */
export function titleProblem(raw: string): string | null {
  const length = Array.from(raw.trim()).length;
  return length >= TITLE_MIN && length <= TITLE_MAX ? null : L2.quickAddTitleInvalid;
}

export interface ParentOption {
  id: string;
  label: string;
}

/** 只列出 Depth ≤2 的父节点（新 Task 最高 L3）；保留历史 L4 数据。 */
export function parentOptions(view: TreeView | undefined): ParentOption[] {
  if (!view) return [];
  const byId = new Map(view.nodes.map((node) => [node.id, node] as const));
  const sections = new Map(view.sections.map((section) => [section.id, section.title] as const));
  const label = (node: TreeNode): string => {
    const parts: string[] = [];
    let current: TreeNode | undefined = node;
    while (current) {
      parts.unshift(current.title);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    const sectionTitle = sections.get(node.sectionId);
    return (sectionTitle ? [sectionTitle, ...parts] : parts).join(' › ');
  };
  return parentChoices(view.nodes).map((node) => ({ id: node.id, label: label(node) }));
}

export type NewChildKind = 'workstream' | 'campaign' | 'task';

/** Match backend parent rules, but do not offer a new legacy Action. */
export function childKindsFor(parentKind: string | undefined): NewChildKind[] {
  if (parentKind === 'initiative' || parentKind === 'knowledge_collection') return ['workstream', 'task'];
  if (parentKind === 'topic') return ['campaign', 'task'];
  if (['workstream', 'campaign', 'task', 'action'].includes(parentKind ?? '')) return ['task'];
  return [];
}

const KIND_LABELS: Record<NewChildKind, string> = {
  workstream: 'Workstream', campaign: 'Campaign', task: 'Task',
};

function QuickAddForm({ initialTitle, presetParent, mode = 'task', presetParentKind, projectRootId }: {
  initialTitle: string;
  presetParent?: string | undefined;
  mode?: 'child' | 'task';
  presetParentKind?: string | undefined;
  projectRootId?: string | undefined;
}) {
  const announce = useAnnounce();
  const uid = useId();
  const route = useRoute();
  const tree = useQuery<TreeView>('tree', (signal) => get<TreeView>('tree', {}, { signal }));
  const options = useMemo(() => {
    const all=parentOptions(tree.data);
    if(!projectRootId)return all;
    const byId=new Map(tree.data?.nodes.map(item=>[item.id,item])??[]);
    const within=(id:string)=>{
      let node=byId.get(id);const seen=new Set<string>();
      while(node && !seen.has(node.id)){
        if(node.id===projectRootId)return true;
        seen.add(node.id);node=node.parentId?byId.get(node.parentId):undefined;
      }
      return false;
    };
    return all.filter(option=>within(option.id));
  },[tree.data,projectRootId]);
  const wanted = presetParent ?? (route.name === 'node' ? route.id : '');
  const initialParent = options.some((item) => item.id === wanted) ? wanted : '';
  const [parentId, setParentId] = useState(initialParent);
  const [parentTouched, setParentTouched] = useState(false);
  const [pickedKind, setPickedKind] = useState<NewChildKind | null>(null);
  const parentKind = tree.data?.nodes.find((item) => item.id === parentId)?.kind ??
    (parentId === presetParent ? presetParentKind : undefined);
  const availableKinds = mode === 'child' ? childKindsFor(parentKind) : (['task'] as NewChildKind[]);
  const kind: NewChildKind = pickedKind && availableKinds.includes(pickedKind)
    ? pickedKind : (availableKinds[0] ?? 'task');
  const heading = mode === 'child' ? `New ${KIND_LABELS[kind]}` : L2.quickAddTitle;
  // The tree may still be loading when the dialog opens: adopt the preset parent once its options exist.
  useEffect(() => {
    if (!parentTouched && parentId === '' && initialParent !== '') setParentId(initialParent);
  }, [initialParent, parentId, parentTouched]);
  const [title, setTitle] = useState(initialTitle);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const problems: Record<string, string> = {};
    const titleError = titleProblem(title);
    if (titleError) problems.title = titleError;
    if (parentId === '' || !options.some(option=>option.id===parentId)) problems.parentId = L2.quickAddParentRequired;
    else if (availableKinds.length === 0) problems.parentId = 'Choose a parent that can contain this item';
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setSaving(true);
    try {
      // Contextual "+" uses the valid structural kind. Explicit New Task and
      // keyboard/palette flows remain strictly kind=task (never action).
      const result = await post<NodeResult>('node-create', { kind, parentId, title: title.trim() });
      afterWrite(result.node);
      announce(`${L2.quickAddDone}: ${result.node.title}`);
      closeQuickAdd();
      if (mode === 'child') navigate(nodePath(result.node.id));
    } catch (error) {
      if (error instanceof ApiError && error.fields.length > 0) setErrors(fieldReasons(error));
      const message = `${L2.quickAddFailed}: ${describeError(error)}`;
      setFailure(message);
      announce(message);
      setSaving(false);
    }
  };

  return (
    <ModalDialog label={heading} onClose={closeQuickAdd} className="modal-quickadd">
      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <h2>{heading}</h2>
        {mode === 'child' && availableKinds.length > 1 ? <div className="field">
          <label htmlFor={`${uid}-kind`}>Create</label>
          <select id={`${uid}-kind`} aria-label="Item type" value={kind}
            onChange={(event) => setPickedKind(event.target.value as NewChildKind)}>
            {availableKinds.map((entry) => <option value={entry} key={entry}>{KIND_LABELS[entry]}</option>)}
          </select>
        </div> : null}
        <div className="field">
          <label htmlFor={`${uid}-title`}>{L2.quickAddField}</label>
          <input
            id={`${uid}-title`}
            type="text"
            data-autofocus
            value={title}
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={errors.title ? `${uid}-title-err` : undefined}
            onChange={(event) => setTitle(event.target.value)}
          />
          {errors.title ? (
            <p id={`${uid}-title-err`} className="field-error error-text">
              {errors.title}
            </p>
          ) : null}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-parent`}>{L2.quickAddParent}</label>
          <select
            id={`${uid}-parent`}
            value={parentId}
            aria-invalid={errors.parentId ? true : undefined}
            onChange={(event) => {
              setParentTouched(true);
              setParentId(event.target.value);
              setPickedKind(null);
            }}
          >
            <option value="">{L2.quickAddParentPlaceholder}</option>
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
          {errors.parentId ? <p className="field-error error-text">{errors.parentId}</p> : null}
          {options.length === 0 && tree.status === 'success' ? <p className="muted">{L2.quickAddNoParent}</p> : null}
        </div>
        {failure ? (
          <p role="alert" className="error-text">
            {failure}
          </p>
        ) : null}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? L.saving : L2.quickAddSubmit}
          </button>
          <button type="button" className="btn" onClick={closeQuickAdd}>
            {L.cancel}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** New Task (Quick_Add): native dialog shared by the N key, the "+" buttons and the Palette `+` entry. */
export function QuickAdd() {
  const ui = useUi();
  return ui.quickAdd ? <QuickAddForm initialTitle={ui.quickAdd.title}
    presetParent={ui.quickAdd.parentId}
    mode={ui.quickAdd.mode ?? 'task'} presetParentKind={ui.quickAdd.parentKind}
    projectRootId={ui.quickAdd.rootId}/> : null;
}
