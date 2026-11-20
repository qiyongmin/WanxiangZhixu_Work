/** Linkify plain URLs in Event Summary while preserving existing safe rich text.
 * Existing anchors, code and preformatted text are never rewritten. */
import { cleanNoteHtml, type CleanResult } from './noteHtml';

const URLS = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,!?;:，。！？；：、]+$/;

function trimUrl(value: string): [string, string] {
  let url = value;
  let removed = '';
  while (url) {
    const last = url.charAt(url.length - 1);
    const close = last === ')' ? ['(', ')'] : last === ']' ? ['[', ']'] : last === '}' ? ['{', '}'] : null;
    if (TRAILING.test(last) || (close &&
      (url.split(close[1]!).length > url.split(close[0]!).length))) {
      removed = last + removed;
      url = url.slice(0, -1);
    } else break;
  }
  return [url, removed];
}

function linkifyTextNodes(root: DocumentFragment): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    if (node.parentElement?.closest('a,pre,code')) continue;
    const text = node.textContent ?? '';
    URLS.lastIndex = 0;
    let match: RegExpExecArray | null;
    let at = 0;
    const fragment = document.createDocumentFragment();
    let found = false;
    while ((match = URLS.exec(text))) {
      const [url, suffix] = trimUrl(match[0]);
      if (!url || !/^https?:\/\//i.test(url)) continue;
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) continue;
      } catch { continue; }
      fragment.append(document.createTextNode(text.slice(at, match.index)));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.textContent = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      fragment.append(anchor, document.createTextNode(suffix));
      at = match.index + match[0].length;
      found = true;
    }
    if (found) {
      fragment.append(document.createTextNode(text.slice(at)));
      node.replaceWith(fragment);
    }
  }
}

export function linkifyEventSummaryHtml(raw: string): CleanResult {
  const cleaned = cleanNoteHtml(raw);
  if (!cleaned.ok) return cleaned;
  const template = document.createElement('template');
  template.innerHTML = cleaned.html;
  linkifyTextNodes(template.content);
  return cleanNoteHtml(template.innerHTML);
}

/** Plain-text paste stays plain text; only safe http(s) URLs become anchors. */
export function linkifyEventPaste(text: string): CleanResult {
  const container = document.createElement('div');
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, index) => {
    if (index > 0) container.append(document.createElement('br'));
    container.append(document.createTextNode(line));
  });
  return linkifyEventSummaryHtml(container.innerHTML);
}
