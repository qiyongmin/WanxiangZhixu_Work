import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { get, isAbort } from '../../lib/api';
import { describeError } from '../../lib/errors';
import { displaySectionTitle, L2 } from '../../lib/labels';
import { navigate, nodePath } from '../../lib/router';
import type { SearchHit } from '../../lib/types';
import { closePalette, openQuickAdd, useUi } from '../../lib/ui';
import { ModalDialog } from '../ModalDialog';

export const DEBOUNCE_MS = 40;
export const RESULT_LIMIT = 50;

/** `+标题`：返回预填标题（去除首尾空白）；不是 `+` 前缀返回 null。 */
export function quickAddTitle(value: string): string | null {
  return value.startsWith('+') ? value.slice(1).trim() : null;
}

type Status = 'idle' | 'loading' | 'ready' | 'error';

function PaletteDialog() {
  const uid = useId();
  const listId = `${uid}-list`;
  const [value, setValue] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<unknown>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  // 输入后 40ms 防抖请求；新输入或关闭时用 AbortController 取消过期请求。
  useEffect(() => {
    const query = value.trim();
    if (query === '' || value.startsWith('+')) {
      setHits([]);
      setStatus('idle');
      return undefined;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setStatus('loading');
      get<SearchHit[]>('search', { q: query, limit: RESULT_LIMIT }, { signal: controller.signal })
        .then((result) => {
          setHits(result);
          setActive(0);
          setError(null);
          setStatus('ready');
        })
        .catch((failure: unknown) => {
          if (isAbort(failure)) return;
          setError(failure);
          setStatus('error');
        });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [value]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, hits]);

  const choose = (hit: SearchHit) => {
    closePalette();
    navigate(nodePath(hit.id));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, Math.max(hits.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const title = quickAddTitle(value);
      if (title !== null) {
        openQuickAdd(title);
        return;
      }
      const hit = hits[active];
      if (hit) choose(hit);
    }
  };

  const trimmed = value.trim();
  const showNone = status === 'ready' && hits.length === 0 && trimmed !== '' && !value.startsWith('+');
  const activeHit = hits[active];
  return (
    <ModalDialog label={L2.paletteTitle} onClose={closePalette} className="modal-palette">
      <div className="palette">
        <input
          type="text"
          role="combobox"
          aria-label={L2.paletteInput}
          aria-expanded={hits.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeHit ? `${uid}-opt-${activeHit.id}` : undefined}
          placeholder={L2.paletteInput}
          autoComplete="off"
          data-autofocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <ul id={listId} role="listbox" aria-label={L2.paletteList} ref={listRef} className="palette-list">
          {hits.map((hit, index) => (
            <li
              key={hit.id}
              id={`${uid}-opt-${hit.id}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'palette-option is-active' : 'palette-option'}
              data-node-id={hit.id}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(hit)}
            >
              <span className="palette-title">{hit.title}</span>
              <span className="palette-meta muted">
                {displaySectionTitle(hit.sectionTitle)} · {hit.nodePath}
              </span>
            </li>
          ))}
        </ul>
        <div className="palette-status" role="status" aria-live="polite">
          {trimmed === '' ? <span className="muted">{L2.paletteHint}</span> : null}
          {status === 'loading' && hits.length === 0 ? <span className="muted">{L2.paletteSearching}</span> : null}
          {showNone ? <span>{L2.paletteNoResult}</span> : null}
          {status === 'error' ? (
            <span className="error-text">
              {L2.paletteFailed}: {describeError(error)}
            </span>
          ) : null}
        </div>
      </div>
    </ModalDialog>
  );
}

/** Command_Palette（Ctrl+K）：role=combobox + listbox；原生 dialog。 */
export function CommandPalette() {
  const ui = useUi();
  return ui.palette ? <PaletteDialog /> : null;
}
