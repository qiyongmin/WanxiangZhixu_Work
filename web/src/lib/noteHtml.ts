// Note 编辑器的 HTML 规范化与图片上传（Req 19）。
import { ApiError, postBinary } from './api';
import { L3 } from './labels';
import { sanitizeHtml } from './sanitize';
import type { NoteImageResult } from './types';

export const MAX_NOTES = 50;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** `note_` + 16 位小写十六进制，符合服务端 `note_[a-z0-9]{8,48}`。 */
export function newNoteId(): string {
  const bytes = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return 'note_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export type CleanResult = { ok: true; html: string } | { ok: false };

/**
 * 把 contenteditable 的 innerHTML 规范成服务端白名单可接受的形式：
 * `<strike>` → `<s>`，去掉没有 href 的 `<a>`（保留文字），再经 DOMPurify 净化。
 */
export function cleanNoteHtml(raw: string): CleanResult {
  const template = document.createElement('template');
  template.innerHTML = raw;
  for (const old of Array.from(template.content.querySelectorAll('strike'))) {
    const replacement = document.createElement('s');
    replacement.append(...Array.from(old.childNodes));
    old.replaceWith(replacement);
  }
  const first = sanitizeHtml(template.innerHTML);
  if (!first.ok) return { ok: false };
  const second = document.createElement('template');
  second.innerHTML = first.html;
  for (const anchor of Array.from(second.content.querySelectorAll('a:not([href])'))) {
    anchor.replaceWith(...Array.from(anchor.childNodes));
  }
  return { ok: true, html: second.innerHTML };
}

export interface ImageProblem {
  message: string;
}

/** 上传前的本地校验：格式与 8 MB 上限。 */
export function checkImage(file: Pick<File, 'type' | 'size'>): ImageProblem | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return { message: L3.imageBadType };
  if (file.size > MAX_IMAGE_BYTES) return { message: L3.imageTooLarge };
  return null;
}

/** 把上传失败转成提示；404 `Unknown API endpoint` 提示重启后端服务。 */
export function imageErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404 && (error.code === 'unknown_endpoint' || /unknown/i.test(error.message))) {
      return L3.imageEndpointMissing;
    }
    if (error.status === 413) return L3.imageTooLarge;
    return error.message;
  }
  return error instanceof Error && error.message ? error.message : L3.imageFailed;
}

export function uploadNoteImage(nodeId: string, file: File): Promise<NoteImageResult> {
  return postBinary<NoteImageResult>(`/api/work-hub/note-image?taskId=${encodeURIComponent(nodeId)}`, file, file.type);
}

export const FILE_URL = /^\/api\/file-hub\/file\?id=file_[0-9a-f]{32}&mode=inline$/;
