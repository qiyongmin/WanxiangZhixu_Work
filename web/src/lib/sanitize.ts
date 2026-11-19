// 受控 HTML 的二次净化（Req 34.7 / 34.11）。白名单与服务端 work_hub_notes.ALLOWED_TAGS 一致。
import DOMPurify from 'dompurify';

export const ALLOWED_TAGS = [
  'p', 'div', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'ul', 'ol', 'li',
  'blockquote', 'h2', 'h3', 'pre', 'code', 'a', 'img', 'span',
  'table', 'tbody', 'thead', 'tr', 'td', 'th',
];
export const NOTE_COLOR_CLASSES = [
  'note-color-default', 'note-color-blue', 'note-color-green',
  'note-color-red', 'note-color-amber', 'note-color-purple',
] as const;
export const ALLOWED_ATTR = ['href', 'target', 'rel', 'src', 'alt', 'loading', 'class',
  'rowspan', 'colspan', 'data-kbw-bg', 'colwidth', 'width', 'height', 'data-kbw-row-height',
  'data-kbw-border-top', 'data-kbw-border-right', 'data-kbw-border-bottom', 'data-kbw-border-left'];
const TABLE_BACKGROUNDS = ['blue', 'green', 'amber', 'rose', 'purple', 'slate'];
const BORDER_TOKEN = /^(?:(solid|dashed|dotted|double):[123]:(default|accent|red|green|amber|purple)|none)$/;
const BORDER_ATTRS = ['data-kbw-border-top', 'data-kbw-border-right',
  'data-kbw-border-bottom', 'data-kbw-border-left'];

/** <img> 仅允许 File Hub 内联地址（与服务端 FILE_SRC 相同）。 */
const FILE_SRC = /^\/api\/file-hub\/file\?id=file_[0-9a-f]{32}&mode=inline$/;
/** <a href>：http(s)、mailto 与站内 #/ 路由（与服务端 _HREF_OK 相同）。 */
const HREF_OK = [/^https?:\/\/[^\s<>\u0000-\u001f]+$/i, /^mailto:[^\s<>\u0000-\u001f]+$/i, /^#\/[-\w/%?.=&]+$/, /^\/app\/n\/[-\w/%?.=&]+$/];

export const UNSAFE_MARKER = 'Content cannot be shown safely';

export interface SanitizeResult {
  ok: boolean;
  /** ok 为 false 时恒为空串：绝不回显原始内容。 */
  html: string;
}

let configured = false;

function configure(): void {
  if (configured) return;
  configured = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
    const tag = node.tagName.toLowerCase();
    // DOMPurify's built-in data attribute rule would otherwise drop the
    // allowlisted table borders, so explicitly remove every unknown data-*.
    for(const attribute of Array.from(node.attributes)){
      if(attribute.name.startsWith('data-') && !ALLOWED_ATTR.includes(attribute.name))
        node.removeAttribute(attribute.name);
    }
    // Only semantic Note color classes can survive. No arbitrary CSS/style,
    // CSS URLs or class names from pasted/remote HTML are permitted.
    const color = node.getAttribute('class');
    if (color && (tag !== 'span' || !(NOTE_COLOR_CLASSES as readonly string[]).includes(color))) {
      node.removeAttribute('class');
    }
    if (tag === 'a') {
      const href = node.getAttribute('href') ?? '';
      if (!HREF_OK.some((pattern) => pattern.test(href))) node.removeAttribute('href');
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (tag === 'td' || tag === 'th') {
      for (const name of BORDER_ATTRS) {
        const value = node.getAttribute(name);
        if (value && !BORDER_TOKEN.test(value)) node.removeAttribute(name);
      }
      const shade = node.getAttribute('data-kbw-bg');
      if (shade && !TABLE_BACKGROUNDS.includes(shade)) node.removeAttribute('data-kbw-bg');
      for (const span of ['rowspan','colspan']) {
        const value = node.getAttribute(span);
        if (value && (!/^\\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 16))
          node.removeAttribute(span);
      }
      const widths = node.getAttribute('colwidth');
      if (widths && (!/^[0-9]{2,4}(,[0-9]{2,4}){0,15}$/.test(widths) ||
        widths.split(',').some(n=>Number(n)<40||Number(n)>2400))) node.removeAttribute('colwidth');
      const width = node.getAttribute('width');
      const parsedWidths = node.getAttribute('colwidth')?.split(',').map(Number);
      if (width && (!/^[0-9]{2,5}$/.test(width) || Number(width)<40 || Number(width)>38400 ||
        (parsedWidths && parsedWidths.reduce((a,b)=>a+b,0)!==Number(width)))) node.removeAttribute('width');
    } else {
      node.removeAttribute('data-kbw-bg');
      for (const name of BORDER_ATTRS) node.removeAttribute(name);
      node.removeAttribute('rowspan');
      node.removeAttribute('colspan');
      node.removeAttribute('width');
      node.removeAttribute('colwidth');
    }
    if (tag === 'tr') {
      const height = node.getAttribute('height');
      const dataHeight = node.getAttribute('data-kbw-row-height');
      if (height && (!/^[0-9]{2,3}$/.test(height) || Number(height)<28 || Number(height)>800 ||
        (dataHeight && dataHeight!==height))) node.removeAttribute('height');
      if (dataHeight && (!/^[0-9]{2,3}$/.test(dataHeight) || Number(dataHeight)<28 ||
        Number(dataHeight)>800 || (height && height!==dataHeight)))
        node.removeAttribute('data-kbw-row-height');
    } else {
      node.removeAttribute('height');
      node.removeAttribute('data-kbw-row-height');
    }
    if (tag === 'img') {
      const src = node.getAttribute('src') ?? '';
      if (!FILE_SRC.test(src)) node.remove();
      else node.setAttribute('loading', 'lazy');
    }
  });
}

export function sanitizeHtml(html: string): SanitizeResult {
  try {
    if (!DOMPurify.isSupported) return { ok: false, html: '' };
    configure();
    const clean = DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: true,
      ALLOW_ARIA_ATTR: false,
      FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form'],
      RETURN_TRUSTED_TYPE: false,
    });
    return { ok: true, html: String(clean) };
  } catch {
    return { ok: false, html: '' };
  }
}
