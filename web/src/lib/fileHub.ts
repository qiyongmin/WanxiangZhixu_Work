// 仅导入新文件，不更新/覆盖已有 File ID。编辑原件只能在 KB_Work/library 目录进行。
import { postBinary } from './api';

export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
export const MATERIAL_FOLDER = 'Projects/WorkHub/Materials';

export function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim();
  return cleaned || 'file';
}

async function uploadOnce(folder: string, name: string, file: File): Promise<{ id: string; name: string }> {
  const query = `folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`;
  return postBinary<{ id: string; name: string }>(`/api/file-hub/upload?${query}`, file, 'application/octet-stream', {
    timeoutMs: 300_000,
  });
}

/** 只新增 canonical 文件；重名冲突直接拒绝，提示到实际目录处理。 */
export async function uploadMaterialFile(file: File, nodeId?: string): Promise<{ id: string; name: string }> {
  const name = safeName(file.name);
  if (nodeId) return postBinary<{ id: string; name: string }>(
    `/api/file-hub/upload?nodeId=${encodeURIComponent(nodeId)}&name=${encodeURIComponent(name)}`,
    file, 'application/octet-stream', { timeoutMs: 300_000 },
  );
  // Legacy callers retain the old fixed folder until explicitly migrated.
  return uploadOnce(MATERIAL_FOLDER, name, file);
}
