import { useEffect, useState, type ReactNode } from 'react';
import { ApiError, getJson } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { L, L3 } from '../../lib/labels';
import {
  fileUrl,
  formatSize,
  markdownDocument,
  MARKDOWN_SANDBOX,
  PREVIEW_TIMEOUT_MS,
  previewKind,
} from '../../lib/preview';
import { ModalDialog } from '../ModalDialog';
import { OfficePreview } from './OfficePreview';
import { FileVersionTools } from './FileVersionTools';

export type PreviewTarget =
  | { kind: 'file'; fileId: string; name: string; size?: number | null; missing?: boolean;
      materialId?: string; revision?: number | null }
  | { kind: 'link'; url: string; title: string };

type Phase = 'loading' | 'ready' | 'error' | 'missing';

interface Props {
  target: PreviewTarget;
  onClose: () => void;
}

function useLoadTimer(phase: Phase, tick: number, setPhase: (value: Phase) => void, armed: boolean): void {
  useEffect(() => {
    if (!armed || phase !== 'loading') return undefined;
    const timer = window.setTimeout(() => setPhase('error'), PREVIEW_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [armed, phase, tick, setPhase]);
}

function InfoCard({ rows, children }: { rows: Array<[string, string]>; children?: ReactNode }) {
  return (
    <div className="preview-card">
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </div>
  );
}

function FilePreview({ target, interactive = false }: { target: Extract<PreviewTarget, { kind: 'file' }>; interactive?: boolean }) {
  const kind = previewKind(target.name, target.size);
  const [phase, setPhase] = useState<Phase>(target.missing ? 'missing' : 'loading');
  const [tick, setTick] = useState(0);
  const [doc, setDoc] = useState<string | null>(null);
  const [plain, setPlain] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const textual = kind === 'markdown' || kind === 'text' || kind === 'extracted';
  const framed = kind === 'html' || kind === 'pdf' || kind === 'image';

  useLoadTimer(phase, tick, setPhase, framed && !target.missing);

  useEffect(() => {
    if (target.missing) {
      setPhase('missing');
      return undefined;
    }
    if (!textual) {
      setPhase(kind === 'other' ? 'ready' : 'loading');
      return undefined;
    }
    const controller = new AbortController();
    setPhase('loading');
    setFailure(null);
    getJson<{ name?: string; text: string; status?: string }>(
      kind === 'extracted' ? `/api/file-hub/extracted?id=${encodeURIComponent(target.fileId)}` : fileUrl(target.fileId, 'preview-text'), {
      signal: controller.signal,
      timeoutMs: PREVIEW_TIMEOUT_MS,
    })
      .then(async (data) => {
        if (kind === 'markdown') setDoc(await markdownDocument(data.text));
        else setPlain(data.text);
        setPhase('ready');
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        if (error instanceof ApiError && error.status === 404) {
          setPhase('missing');
          return;
        }
        setFailure(describeError(error));
        setPhase('error');
      });
    return () => controller.abort();
  }, [target.fileId, target.missing, kind, textual, tick]);

  const retry = () => {
    setFailure(null);
    setPhase('loading');
    setTick((value) => value + 1);
  };

  if (phase === 'missing') {
    return (
      <p role="alert" className="preview-missing">
        {L3.previewMissing}
      </p>
    );
  }
  if (kind === 'other') {
    return (
      <InfoCard
        rows={[
          [L3.previewName, target.name],
          [L3.previewType, target.name.includes('.') ? target.name.split('.').pop()!.toLowerCase() : '—'],
          [L3.previewSize, formatSize(target.size)],
        ]}>
        <p className="muted">{L3.previewTooLarge}</p>
        <a className="btn" href={fileUrl(target.fileId, 'download')} download={target.name}>
          {L3.previewDownload}
        </a>
      </InfoCard>
    );
  }
  const url = (mode: 'inline' | 'safe-html') => fileUrl(target.fileId, mode);
  return (
    <div className="preview-body" data-phase={phase}>
      {phase === 'loading' ? (
        <p className="muted" role="status">
          {L3.previewLoading}
        </p>
      ) : null}
      {phase === 'error' ? (
        <div role="alert" className="preview-error">
          <p className="error-text">
            {L3.previewFailed}
            {failure ? `: ${failure}` : ''}
          </p>
          <button type="button" className="btn" onClick={retry}>
            {L.retry}
          </button>
        </div>
      ) : null}
      {kind === 'markdown' && doc !== null && phase === 'ready' ? (
        <iframe className="preview-frame" title={target.name} sandbox={MARKDOWN_SANDBOX} srcDoc={doc} />
      ) : null}
      {kind === 'text' && plain !== null && phase === 'ready' ? <pre className="preview-text">{plain}</pre> : null}
      {kind === 'extracted' && phase === 'ready' ? (
        <div className="preview-extracted">
          <p className="muted">Text-only preview from the local File Hub index. Original formatting, tables and images may differ; download the original for full fidelity.</p>
          {plain ? <pre className="preview-text">{plain}</pre> : <p className="muted">No extracted text is available for this file. Download the original to view it.</p>}
        </div>
      ) : null}
      {kind === 'html' ? (
        <>
          <iframe
            key={`html-${interactive ? 'interactive' : 'safe'}-${tick}`}
            className="preview-frame"
            title={target.name}
            sandbox={interactive ? 'allow-scripts' : ''}
            src={interactive ? fileUrl(target.fileId, 'html') : url('safe-html')}
            hidden={phase !== 'ready'}
            onLoad={() => setPhase('ready')}
          />
          <a className="preview-legacy" href={fileUrl(target.fileId, 'html')} target="_blank" rel="noopener noreferrer">
            {L3.previewLegacy}
          </a>
        </>
      ) : null}
      {kind === 'pdf' ? (
        <iframe
          key={`pdf-${tick}`}
          className="preview-frame"
          title={target.name}
          src={url('inline')}
          hidden={phase !== 'ready'}
          onLoad={() => setPhase('ready')}
        />
      ) : null}
      {kind === 'image' ? (
        <img
          key={`img-${tick}`}
          className="preview-image"
          alt={target.name}
          src={url('inline')}
          hidden={phase !== 'ready'}
          onLoad={() => setPhase('ready')}
          onError={() => {
            setFailure(null);
            setPhase('error');
          }}
        />
      ) : null}
    </div>
  );
}

function LinkPreview({ target }: { target: Extract<PreviewTarget, { kind: 'link' }> }) {
  return (
    <InfoCard rows={[[L3.previewName, target.title], ['URL', target.url]]}>
      <a className="btn btn-primary" href={target.url} target="_blank" rel="noopener noreferrer">
        {L3.previewOpenLink}
      </a>
    </InfoCard>
  );
}

/** Reusable preview body for central Focus Workspace and the legacy Drawer.
 * Both use the exact same sandboxed HTML / CSP / File Hub file URL rules. */
export function PreviewContent({ target, inlineControls = true, initialMaximized = false }: {
  target: PreviewTarget; inlineControls?: boolean; initialMaximized?: boolean;
}) {
  const [maximized, setMaximized] = useState(initialMaximized);
  // Original HTML is best viewed with its interactions, in a sandboxed
  // opaque-origin frame and the existing restrictive File Hub CSP.
  const [interactive, setInteractive] = useState(() => target.kind === 'file' && previewKind(target.name, target.size) === 'html');
  useEffect(() => {
    if (!maximized) return undefined;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setMaximized(false);
      }
    };
    document.addEventListener('keydown', onEscape, true);
    return () => document.removeEventListener('keydown', onEscape, true);
  }, [maximized]);
  if (target.kind === 'link') return <LinkPreview target={target} />;
  const kind = previewKind(target.name, target.size);
  const pinned = target.revision !== null && target.revision !== undefined;
  const historical = pinned ? `&revision=${target.revision}` : '';
  const newTab = fileUrl(target.fileId, kind === 'html' ? 'html' : kind === 'pdf' || kind === 'image' ? 'inline' : 'download') + historical;
  const download = fileUrl(target.fileId, 'download') + historical;
  return (
    <div className={maximized ? 'preview-stage is-maximized' : 'preview-stage'} data-preview-kind={kind}>
      {inlineControls ? <div className="preview-actions" role="toolbar" aria-label="File preview actions">
        <span className="muted preview-file-name" title={target.name}>{target.name}</span>
        {kind === 'html' ? (
          <button className="btn" type="button" aria-pressed={interactive}
            onClick={() => setInteractive((current) => !current)}>
            {interactive ? 'Safe HTML' : 'Interactive HTML'}
          </button>
        ) : null}
        <button type="button" className="btn" aria-label={maximized ? 'Restore preview' : 'Maximize preview'}
          onClick={() => setMaximized((value) => !value)}>
          {maximized ? 'Restore' : 'Maximize'}
        </button>
        <a className="btn" href={newTab} target="_blank" rel="noopener noreferrer" aria-label="Open file in new tab">Open in new tab</a>
        <a className="btn" href={download} download={target.name}>Download</a>
      </div> : null}
      {!inlineControls && kind === 'html' ? <div className="preview-safe-control">
        <button type="button" className="btn" onClick={() => setInteractive((value) => !value)}>
          {interactive ? 'Safe HTML' : 'Interactive HTML'}
        </button>
      </div> : null}
      {!inlineControls && maximized ? <button type="button" className="btn preview-exit-fullscreen"
        aria-label="Restore preview" onClick={() => setMaximized(false)}>Exit full screen</button> : null}
      {pinned ? <section className="preview-pinned-evidence" aria-label="Pinned historical evidence">
        <p role="status"><strong>Historical evidence pinned to Revision {target.revision}</strong>.
          This reference deliberately does not follow the current version of the file.</p>
        {kind === 'pdf' ? <iframe className="preview-frame" title={target.name}
          src={fileUrl(target.fileId, 'inline') + historical} /> : null}
        {kind === 'image' ? <img className="preview-image" alt={target.name}
          src={fileUrl(target.fileId, 'inline') + historical}/> : null}
        {kind !== 'pdf' && kind !== 'image' ? <p className="muted">Download the preserved historical original to inspect this exact evidence. The latest document is not substituted.</p> : null}
        <a className="btn" href={download}>Download pinned Revision {target.revision}</a>
      </section> : kind === 'extracted' ? <OfficePreview key={target.fileId} fileId={target.fileId} name={target.name}
        fallback={<FilePreview target={target} interactive={interactive}/>} /> :
        <FilePreview key={target.fileId} target={target} interactive={interactive} />}
      {inlineControls ? <FileVersionTools fileId={target.fileId} materialId={target.materialId} pinnedRevision={target.revision} /> : null}
    </div>
  );
}

/** 右侧抽屉（原生 <dialog>）：焦点圈定、Esc 与关闭控件还原焦点（Req 35.9）。 */
export function PreviewDrawer({ target, onClose }: Props) {
  const title = target.kind === 'file' ? target.name : target.title;
  return (
    <ModalDialog label={`${L3.previewTitle}: ${title}`} onClose={onClose} className="drawer">
      <div className="drawer-head">
        <h2 className="drawer-title">{title}</h2>
        <button type="button" className="btn" data-autofocus onClick={onClose}>
          {L.close}
        </button>
      </div>
      <div className="drawer-content">
        <PreviewContent target={target} />
      </div>
    </ModalDialog>
  );
}
