import { useState } from 'react';
import { acceptDraftNavigation, cancelDraftNavigation, getDraftPending, useDraftRevision } from '../lib/draftGuard';
import { ModalDialog } from './ModalDialog';

/** One shared guard for Note editor and Inspector drafts, including tree links. */
export function DraftGuardDialog() {
  useDraftRevision();
  const pending = getDraftPending();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!pending) return null;
  const choose = async (action: 'save' | 'discard') => {
    setBusy(true);
    setError('');
    try {
      const ok = await acceptDraftNavigation(action);
      if (!ok) setError('The changes could not be saved. Review the editor and resolve any conflicts before leaving.');
    } catch {
      setError('Save failed; your unsaved changes are still in the editor.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalDialog label="Unsaved changes" onClose={cancelDraftNavigation}>
      <div className="draft-guard" role="group" aria-label="Navigation with unsaved work">
        <h2>Unsaved changes</h2>
        <p>Save your work before leaving? The draft stays in this session while you decide.</p>
        {error ? <p role="alert" className="error-text">{error}</p> : null}
        <div className="form-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void choose('save')}>Save &amp; continue</button>
          <button type="button" className="btn" disabled={busy} onClick={cancelDraftNavigation}>Continue editing</button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void choose('discard')}>Discard &amp; leave</button>
        </div>
      </div>
    </ModalDialog>
  );
}
