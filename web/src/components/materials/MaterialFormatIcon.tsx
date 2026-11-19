/** One file identity language across Work Context, Materials management, and File Hub references.
 * Purely presentational: uses the real file name/format, not Material IDs. */
export type MaterialFormat = 'pdf' | 'word' | 'sheet' | 'slides' | 'markdown' | 'html' |
  'image' | 'video' | 'audio' | 'text' | 'archive' | 'link' | 'file';

export function materialFormatOf(name: string, materialType?: string, format?: string | null): MaterialFormat {
  if (materialType === 'link') return 'link';
  const extension = name.trim().split(/[?#]/, 1)[0]?.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase() ??
    (format ?? '').toLowerCase();
  if (extension === 'pdf') return 'pdf';
  if (['doc', 'docx', 'odt', 'rtf'].includes(extension)) return 'word';
  if (['xls', 'xlsx', 'ods', 'csv', 'tsv'].includes(extension)) return 'sheet';
  if (['ppt', 'pptx', 'odp', 'key'].includes(extension)) return 'slides';
  if (['md', 'markdown'].includes(extension)) return 'markdown';
  if (['html', 'htm'].includes(extension)) return 'html';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'heic'].includes(extension)) return 'image';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(extension)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(extension)) return 'audio';
  if (['zip', '7z', 'rar', 'tar', 'gz'].includes(extension)) return 'archive';
  if (['txt', 'json', 'xml', 'yaml', 'yml', 'log'].includes(extension)) return 'text';
  return 'file';
}

const LABELS: Record<MaterialFormat, string> = {
  pdf: 'PDF', word: 'DOC', sheet: 'XLS', slides: 'PPT', markdown: 'MD', html: 'HTML',
  image: 'IMG', video: 'VID', audio: 'AUD', text: 'TXT', archive: 'ZIP', link: 'URL', file: 'FILE',
};

export function MaterialFormatIcon({ name, materialType, format }: {
  name: string; materialType?: string; format?: string | null;
}) {
  const kind = materialFormatOf(name, materialType, format);
  return (
    <span className="material-format-icon" data-file-format={kind} role="img" aria-label={`${LABELS[kind]} ${kind === 'link' ? 'link' : 'file'}`}>
      <svg aria-hidden="true" width="22" height="23" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        {kind === 'link'
          ? <><path d="M10.3 13.7a4 4 0 0 0 6 .35l2.1-2.1a4 4 0 0 0-5.65-5.65l-1.2 1.2" />
              <path d="M13.7 10.3a4 4 0 0 0-6-.35l-2.1 2.1a4 4 0 0 0 5.65 5.65l1.2-1.2" /></>
          : <><path d="M6 2.8h8l4.5 4.5V21H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1.2Z" />
              <path d="M14 3v5h4.5M8.5 12h7M8.5 16h7" /></>}
      </svg>
      <span className="material-format-label">{LABELS[kind]}</span>
    </span>
  );
}
