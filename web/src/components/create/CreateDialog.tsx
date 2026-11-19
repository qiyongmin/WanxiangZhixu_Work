import { useId, useMemo, useState, type FormEvent } from 'react';
import { ApiError, get, post } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { displaySectionTitle, L, L2, L4 } from '../../lib/labels';
import { afterWrite } from '../../lib/nodeData';
import { fieldReasons } from '../../lib/nodeForm';
import { afterSectionWrite, describeSectionError, sectionApi, titleProblem as sectionTitleProblem } from '../../lib/phase4';
import { useQuery } from '../../lib/queryCache';
import { navigate, nodePath } from '../../lib/router';
import type { NodeResult, TreeView } from '../../lib/types';
import { closeCreate, useUi } from '../../lib/ui';
import { useAnnounce } from '../announce';
import { ModalDialog } from '../ModalDialog';
import { titleProblem as itemTitleProblem } from '../quickadd/QuickAdd';

function ItemForm({ presetSection }: { presetSection?: string | undefined }) {
  const announce = useAnnounce();
  const uid = useId();
  const tree = useQuery<TreeView>('tree', (signal) => get<TreeView>('tree', {}, { signal }));
  const sections = useMemo(
    () => (tree.data?.sections ?? []).filter((section) => !section.virtual && section.itemKind),
    [tree.data],
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const sectionId = chosen ?? (presetSection && sections.some((section) => section.id === presetSection) ? presetSection : '');
  const [title, setTitle] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const section = sections.find((item) => item.id === sectionId);
    const problems: Record<string, string> = {};
    const titleError = itemTitleProblem(title);
    if (titleError) problems.title = titleError;
    if (!section) problems.sectionId = L2.itemSectionRequired;
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0 || !section) return;
    setSaving(true);
    try {
      const result = await post<NodeResult>('node-create', {
        kind: section.itemKind,
        sectionId: section.id,
        title: title.trim(),
      });
      afterWrite(result.node);
      announce(`${L2.itemCreated}: ${result.node.title}`);
      closeCreate();
      navigate(nodePath(result.node.id));
    } catch (error) {
      if (error instanceof ApiError && error.fields.length > 0) setErrors(fieldReasons(error));
      const message = `${L2.quickAddFailed}: ${describeError(error)}`;
      setFailure(message);
      announce(message);
      setSaving(false);
    }
  };

  return (
    <ModalDialog label={L2.newItem} onClose={closeCreate} className="modal-quickadd">
      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <h2>{L2.newItem}</h2>
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
          <label htmlFor={`${uid}-section`}>{L2.itemSection}</label>
          <select
            id={`${uid}-section`}
            value={sectionId}
            aria-invalid={errors.sectionId ? true : undefined}
            onChange={(event) => setChosen(event.target.value)}
          >
            <option value="">{L2.itemSectionPlaceholder}</option>
            {sections.map((section) => (
              <option key={section.id} value={section.id}>
                {displaySectionTitle(section.title)}
              </option>
            ))}
          </select>
          {errors.sectionId ? <p className="field-error error-text">{errors.sectionId}</p> : null}
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
          <button type="button" className="btn" onClick={closeCreate}>
            {L.cancel}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

function SectionForm() {
  const announce = useAnnounce();
  const uid = useId();
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const issue = sectionTitleProblem(title);
    setProblem(issue);
    if (issue) return;
    setSaving(true);
    try {
      await sectionApi.create(title);
      afterSectionWrite();
      announce(L2.sectionCreated);
      closeCreate();
    } catch (error) {
      const message = describeSectionError(error);
      setProblem(message);
      announce(message);
      setSaving(false);
    }
  };

  return (
    <ModalDialog label={L2.newSection} onClose={closeCreate} className="modal-quickadd">
      <form className="form" onSubmit={(event) => void submit(event)} noValidate>
        <h2>{L2.newSection}</h2>
        <div className="field">
          <label htmlFor={`${uid}-title`}>{L2.sectionCreateTitle}</label>
          <input
            id={`${uid}-title`}
            type="text"
            data-autofocus
            value={title}
            aria-invalid={problem ? true : undefined}
            aria-describedby={`${uid}-hint`}
            onChange={(event) => setTitle(event.target.value)}
          />
          <p id={`${uid}-hint`} className={problem ? 'field-error error-text' : 'muted'} role={problem ? 'alert' : undefined}>
            {problem ?? L4.sectionTitleHint}
          </p>
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? L.saving : L2.quickAddSubmit}
          </button>
          <button type="button" className="btn" onClick={closeCreate}>
            {L.cancel}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** New Item / New Section dialogs (New Task is the Quick_Add dialog). Opened from the "+" buttons. */
export function CreateDialog() {
  const ui = useUi();
  if (!ui.create) return null;
  return ui.create.kind === 'section' ? <SectionForm /> : <ItemForm presetSection={ui.create.sectionId} />;
}
