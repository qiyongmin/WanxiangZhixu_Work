// Preview_Drawer 的类型判定与 Markdown 渲染（设计 4.11 / Req 20）。
export const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
// Archived self-contained HTML guides can be considerably larger than text
// notes. They are served as sandboxed documents (never in the app DOM).
export const HTML_PREVIEW_MAX_BYTES = 75 * 1024 * 1024;
export const PREVIEW_TIMEOUT_MS = 10_000;

export type PreviewKind = 'markdown' | 'text' | 'html' | 'pdf' | 'image' | 'extracted' | 'other';

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp'];

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Read-only preview decision. HTML uses an isolated 75 MiB limit;
 * other inline formats retain the conservative 10 MiB limit. */
export function previewKind(name: string, size?: number | null): PreviewKind {
  const ext = extensionOf(name);
  const indexedOffice = ['doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'csv', 'ppt', 'pptx', 'odp'].includes(ext);
  // Office previews read an already-indexed text extract, not the original binary.
  if (indexedOffice) return 'extracted';
  if (typeof size === 'number' && size > (ext === 'html' || ext === 'htm' ? HTML_PREVIEW_MAX_BYTES : PREVIEW_MAX_BYTES)) return 'other';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt') return 'text';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXT.includes(ext)) return 'image';
  return 'other';
}

export function fileUrl(fileId: string, mode: 'inline' | 'preview-text' | 'safe-html' | 'download' | 'html'): string {
  return `/api/file-hub/file?id=${encodeURIComponent(fileId)}&mode=${mode}`;
}

export function formatSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const FRAME_STYLE =
  'body{font:14px/1.6 "Inter Variable","Noto Sans SC Variable",system-ui,sans-serif;margin:16px;overflow-wrap:anywhere}pre{white-space:pre-wrap}' +
  'code{font-family:"JetBrains Mono Variable",ui-monospace,monospace}table{border-collapse:collapse}td,th{border:1px solid currentColor;padding:4px 8px}';

/** Markdown → 完整 srcdoc 文档。markdown-it 动态加载，`html:false`，链接补 rel/target，文档内含 CSP meta。 */
export async function markdownDocument(source: string): Promise<string> {
  const { default: MarkdownIt } = await import('markdown-it');
  const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
  const defaultOpen =
    md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (token) {
      token.attrSet('rel', 'noopener noreferrer');
      token.attrSet('target', '_blank');
    }
    return defaultOpen(tokens, idx, options, env, self);
  };
  const body = md.render(source);
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style>${FRAME_STYLE}</style></head><body>${body}</body></html>`
  );
}

/** iframe 的 sandbox 属性值（Markdown：仅允许弹出新窗口；绝不含 allow-scripts / allow-same-origin）。 */
export const MARKDOWN_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';
