import { useId, useState, type FormEvent } from 'react';
import { addTag } from '../../lib/inspector';
import { L, L2 } from '../../lib/labels';
import { AppLink } from '../AppLink';
import { Icon } from '../icons';
import { ModalDialog } from '../ModalDialog';

interface Props {
  tags: readonly string[];
  onChange: (next: string[]) => void;
  error?: string;
}

function AddTagDialog({ tags, onAdd, onClose }: { tags: readonly string[]; onAdd: (next: string[]) => void; onClose: () => void }) {
  const uid = useId();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (text.trim() === '') {
      onClose();
      return;
    }
    const result = addTag(tags, text);
    if ('error' in result) {
      setProblem(result.error);
      return;
    }
    onAdd(result.tags);
    onClose();
  };

  return (
    <ModalDialog label={L2.tagNew} onClose={onClose} className="modal-small" portal>
      <form className="form" onSubmit={submit} noValidate>
        <h2>{L2.tagNew}</h2>
        <div className="field">
          <label htmlFor={`${uid}-in`}>{L2.tagInput}</label>
          <input
            id={`${uid}-in`}
            type="text"
            data-autofocus
            value={text}
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${uid}-err` : undefined}
            onChange={(event) => setText(event.target.value)}
          />
          {problem ? (
            <p id={`${uid}-err`} role="alert" className="field-error error-text">
              {problem}
            </p>
          ) : null}
        </div>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">
            {L2.tagAdd}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {L.cancel}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** Tag editor (at most 20 Tags, each at most 32 characters). Each Tag links to `/tag/:tag`; "+" opens a small dialog. */
export function TagEditor({ tags, onChange, error }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="tag-editor">
      <ul className="tag-list" aria-label={L2.fieldTags}>
        {tags.map((tag) => (
          <li key={tag} className="tag-item">
            <AppLink to={`/tag/${encodeURIComponent(tag)}`} className="tag-chip">
              {tag}
            </AppLink>
            <button
              type="button"
              className="btn btn-icon btn-ghost"
              aria-label={`${L2.tagRemove}: ${tag}`}
              title={`${L2.tagRemove}: ${tag}`}
              onClick={() => onChange(tags.filter((item) => item !== tag))}
            >
              <Icon name="close" size={12} />
            </button>
          </li>
        ))}
        <li className="tag-item">
          <button
            type="button"
            className="btn btn-icon btn-ghost"
            aria-label={L2.tagNew}
            title={L2.tagNew}
            onClick={() => setOpen(true)}
          >
            <Icon name="plus" />
          </button>
        </li>
      </ul>
      {error ? <p className="field-error error-text">{error}</p> : null}
      {open ? <AddTagDialog tags={tags} onAdd={onChange} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}
