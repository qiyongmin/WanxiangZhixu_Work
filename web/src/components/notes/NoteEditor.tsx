import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { L3 } from '../../lib/labels';
import { createPortal } from 'react-dom';
import { checkImage, imageErrorMessage, uploadNoteImage } from '../../lib/noteHtml';
import { NOTE_COLOR_CLASSES } from '../../lib/sanitize';
import { useAnnounce } from '../announce';
import { UnconfirmedControls } from '../agent/UnconfirmedMark';
import { Icon } from '../icons';

export interface Draft {
  id: string;
  title: string;
  html: string;
  expanded: boolean;
  /** 外部（服务端）重设 html 时递增，使编辑区重新写入 innerHTML。 */
  sync: number;
}

interface ToolDef {
  key: keyof typeof L3.tools;
  glyph: string;
  command: string;
  value?: string;
}

// document.execCommand 已被标准标为过时，但仍是 contenteditable 最小可行方案（风险 R4 已登记）。
const TOOLS: ToolDef[] = [
  { key: 'bold', glyph: 'B', command: 'bold' },
  { key: 'italic', glyph: 'I', command: 'italic' },
  { key: 'underline', glyph: 'U', command: 'underline' },
  { key: 'strike', glyph: 'S', command: 'strikeThrough' },
  { key: 'h2', glyph: 'H2', command: 'formatBlock', value: 'h2' },
  { key: 'h3', glyph: 'H3', command: 'formatBlock', value: 'h3' },
  { key: 'list', glyph: '•', command: 'insertUnorderedList' },
  { key: 'quote', glyph: '❝', command: 'formatBlock', value: 'blockquote' },
  { key: 'code', glyph: '</>', command: 'formatBlock', value: 'pre' },
  { key: 'link', glyph: '🔗', command: 'createLink' },
];

interface Props {
  nodeId: string;
  ordinal: number;
  draft: Draft;
  titleProblem: string | null;
  unconfirmedWriteId: string | null;
  legacy: boolean;
  lastModifiedAt?: string | undefined;
  /** V3 mounts one shared formatting toolbar in the Notebook, outside each Page. */
  toolbarTarget?: HTMLElement | null;
  /** OneNote Canvas: editor-only, all management controls live in the Pages menu. */
  canvasMode?: boolean;
  onTitle: (id: string, title: string) => void;
  onHtml: (id: string, html: string) => void;
  onToggle: (id: string) => void;
  onDelete: (id: string) => void;
}

export function NoteEditor({ nodeId, ordinal, draft, titleProblem, unconfirmedWriteId, legacy, lastModifiedAt, toolbarTarget, canvasMode=false, onTitle, onHtml, onToggle, onDelete }: Props) {
  const announce = useAnnounce();
  const uid = useId();
  const editor = useRef<HTMLDivElement>(null);
  const range = useRef<Range | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  // A title is a disclosure target. Rename is an explicit, independently
  // accessible action so a tap never changes a saved name accidentally.
  const [renaming, setRenaming] = useState(() => !draft.title.trim());
  const savedDate = lastModifiedAt && Number.isFinite(Date.parse(lastModifiedAt))
    ? new Date(lastModifiedAt) : null;
  const formattedDate = savedDate
    ? new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(savedDate)
    : null;

  useLayoutEffect(() => {
    if (editor.current) editor.current.innerHTML = draft.html;
    // 仅在 sync 变化（初始化或服务端重设）时写入，输入过程中不覆盖光标。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.sync]);

  useEffect(() => {
    const remember = () => {
      const selection = window.getSelection();
      const current = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      if (current && editor.current?.contains(current.commonAncestorContainer)) range.current = current.cloneRange();
    };
    document.addEventListener('selectionchange', remember);
    return () => document.removeEventListener('selectionchange', remember);
  }, []);

  const emit = useCallback(() => {
    if (editor.current) onHtml(draft.id, editor.current.innerHTML);
  }, [draft.id, onHtml]);

  const restoreRange = () => {
    const target = editor.current;
    if (!target) return null;
    target.focus();
    const selection = window.getSelection();
    let current = range.current;
    if (!current || !target.contains(current.commonAncestorContainer)) {
      current = document.createRange();
      current.selectNodeContents(target);
      current.collapse(false);
    }
    selection?.removeAllRanges();
    selection?.addRange(current);
    return current;
  };

  const insertNode = (node: Node) => {
    const current = restoreRange();
    if (!current) return;
    current.deleteContents();
    current.insertNode(node);
    current.setStartAfter(node);
    current.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(current);
    range.current = current.cloneRange();
    emit();
  };

  const insertText = (text: string) => {
    restoreRange();
    if (typeof document.execCommand === 'function' && document.execCommand('insertText', false, text)) {
      emit();
      return;
    }
    insertNode(document.createTextNode(text));
  };

  const exec = (tool: ToolDef) => {
    restoreRange();
    let value = tool.value;
    if (tool.command === 'createLink') {
      const url = window.prompt(L3.linkPrompt, 'https://');
      if (!url || !/^https?:\/\/[^\s<>]+$/i.test(url.trim())) return;
      value = url.trim();
    }
    if (typeof document.execCommand === 'function') document.execCommand(tool.command, false, value);
    emit();
  };

  const applyTextColor = (token: (typeof NOTE_COLOR_CLASSES)[number]) => {
    const current = restoreRange();
    if (!current || current.collapsed) {
      setMessage('Select text in the Note before choosing a color.');
      return;
    }
    // Only tokens validated by the Work backend are stored. Never store style=.
    const colored = document.createElement('span');
    colored.className = token;
    try {
      const selected = current.extractContents();
      colored.append(selected);
      current.insertNode(colored);
      const next = document.createRange();
      next.selectNodeContents(colored);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(next);
      range.current = next.cloneRange();
      setMessage(null);
      emit();
    } catch {
      setMessage('Select a single passage to change its color.');
    }
  };

  const addImages = async (files: File[]) => {
    for (const file of files) {
      const problem = checkImage(file);
      if (problem) {
        setMessage(`${L3.imageFailed}: ${problem.message}`);
        announce(`${L3.imageFailed}: ${problem.message}`);
        continue;
      }
      setUploading((n) => n + 1);
      setMessage(null);
      try {
        const saved = await uploadNoteImage(nodeId, file);
        const image = document.createElement('img');
        image.setAttribute('src', saved.url);
        image.setAttribute('alt', '');
        image.setAttribute('loading', 'lazy');
        insertNode(image);
      } catch (error) {
        const reason = imageErrorMessage(error);
        setMessage(`${L3.imageFailed}: ${reason}`);
        announce(`${L3.imageFailed}: ${reason}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const imagesOf = (list: DataTransferItemList | FileList | null | undefined): File[] => {
    const out: File[] = [];
    if (!list) return out;
    for (const item of Array.from(list as ArrayLike<DataTransferItem | File>)) {
      const file = item instanceof File ? item : item.kind === 'file' ? item.getAsFile() : null;
      if (file && file.type.startsWith('image/')) out.push(file);
    }
    return out;
  };

  // 粘贴一律纯文本；图片文件走上传。
  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    const images = imagesOf(event.clipboardData?.items);
    if (images.length > 0) {
      void addImages(images);
      return;
    }
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) insertText(text);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const images = imagesOf(event.dataTransfer?.files);
    event.preventDefault();
    if (images.length > 0) void addImages(images);
  };

  const formattingToolbar = (
    <div className="note-toolbar" role="toolbar" aria-label={L3.noteToolbar}>
                {TOOLS.map((tool) => (
                  <button
                    key={tool.key}
                    type="button"
                    className="btn btn-icon"
                    aria-label={L3.tools[tool.key]}
                    title={L3.tools[tool.key]}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => exec(tool)}
                  >
                    {tool.glyph}
                  </button>
                ))}
                <label className="note-color-control">
                  <span className="visually-hidden">Text color</span>
                  <select aria-label="Text color" defaultValue=""
                    title="Select some Note text, then choose a color"
                    onChange={(event) => {
                      const chosen = event.currentTarget.value;
                      if ((NOTE_COLOR_CLASSES as readonly string[]).includes(chosen)) {
                        applyTextColor(chosen as (typeof NOTE_COLOR_CLASSES)[number]);
                      }
                      event.currentTarget.value = '';
                    }}>
                    <option value="" disabled>Text color</option>
                    <option value="note-color-default">Default</option>
                    <option value="note-color-blue">Blue</option>
                    <option value="note-color-green">Green</option>
                    <option value="note-color-red">Red</option>
                    <option value="note-color-amber">Amber</option>
                    <option value="note-color-purple">Purple</option>
                  </select>
                </label>
              </div>
  );
  const headingId = `${uid}-h`;
  const bodyId = `${uid}-b`;
  return (
    <article className="note-card" data-note-id={draft.id} aria-label={draft.title.trim() || L3.noteUntitled}>
      {!canvasMode ? <header className="note-head">
        <span className="note-ordinal" aria-hidden="true">NOTE {String(ordinal).padStart(2, '0')}</span>
        <div className="note-title-label">
          {renaming ? (
            <label htmlFor={`${uid}-t`}>
              <span className="visually-hidden">{L3.noteTitle}</span>
              <input
                id={`${uid}-t`}
                className="note-title-input"
                type="text"
                autoFocus
                value={draft.title}
                placeholder="Enter note name"
                required
                maxLength={200}
                aria-invalid={titleProblem ? true : undefined}
                onChange={(event) => onTitle(draft.id, event.target.value)}
                onBlur={() => { if (draft.title.trim()) setRenaming(false); }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === 'Escape') {
                    event.preventDefault();
                    if (draft.title.trim()) setRenaming(false);
                  }
                }}
              />
            </label>
          ) : (
            <button type="button" className="note-title-toggle"
              aria-expanded={draft.expanded} aria-controls={bodyId}
              onClick={() => onToggle(draft.id)}>
              {draft.title.trim() || L3.noteUntitled}
            </button>
          )}
          {!draft.expanded ? (
            <span className="note-modified">
              {savedDate && lastModifiedAt ? (
                <time dateTime={lastModifiedAt} title={lastModifiedAt}>
                  Last modified · {formattedDate}
                </time>
              ) : 'Last modified · unavailable'}
            </span>
          ) : null}
        </div>
        <button type="button" className="btn btn-icon note-rename"
          aria-label={`Rename Note: ${draft.title.trim() || L3.noteUntitled}`}
          title="Rename Note" onClick={() => setRenaming(true)}>
          <Icon name="edit" size={15}/>
        </button>
        <button type="button" className="btn note-toggle"
          id={headingId}
          aria-label={`${draft.expanded ? 'Collapse' : 'Expand'} Note: ${draft.title.trim() || L3.noteUntitled}`}
          aria-expanded={draft.expanded} aria-controls={bodyId}
          onClick={() => onToggle(draft.id)}>
          <span aria-hidden="true">{draft.expanded ? '▾' : '▸'}</span>
        </button>
        {unconfirmedWriteId ? <UnconfirmedControls writeId={unconfirmedWriteId} subject={draft.title} /> : null}
        <button type="button" className="btn btn-danger" onClick={() => onDelete(draft.id)}
          aria-label={`${L3.noteDelete}: ${draft.title.trim() || L3.noteUntitled}`}>
          {L3.noteDelete}
        </button>
      </header> : null}
      {titleProblem ? <p className="field-error error-text note-title-error">{titleProblem}</p> : null}
      <div id={bodyId} className="note-body" hidden={!draft.expanded}>
        {legacy ? <p className="muted">{L3.noteLegacyHint}</p> : null}
        {toolbarTarget === undefined ? formattingToolbar : toolbarTarget ? createPortal(formattingToolbar,toolbarTarget) : null}

        <div
          ref={editor}
          className="note-editor summary-html"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-label={`${L3.noteBody}: ${draft.title}`}
          tabIndex={0}
          onInput={emit}
          onBlur={emit}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={(event) => event.preventDefault()}
        />
        {uploading > 0 ? (
          <p className="muted" role="status">
            {L3.imageUploading}
          </p>
        ) : null}
        {message ? (
          <p role="alert" className="error-text">
            {message}
          </p>
        ) : null}
      </div>
    </article>
  );
}
