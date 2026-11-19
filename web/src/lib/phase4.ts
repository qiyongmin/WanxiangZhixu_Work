// Phase 4 的数据访问：Section 管理、File Hub 管理、备份验证与切换。
import { ApiError, get, getJson, post, postBinary, postFileHub } from './api';
import { describeError } from './errors';
import { L4 } from './labels';
import { invalidate } from './queryCache';
import type {
  BackupVerifyReport,
  FileRefs,
  HubDetail,
  HubFile,
  HubListing,
  IntegrityView,
  RuleViolation,
  SectionAdminItem,
} from './types';

export const MAX_TITLE = 50;
export const MAX_FILE_BYTES = 104_857_600; // 100 MB
export const REF_CHUNK = 50;
export const LONG_TIMEOUT_MS = 130_000;

// ---- Section ----
export function trimmedTitle(raw: string): string {
  return raw.trim();
}

/** 客户端预检：与服务器相同的 1–50 字符规则；返回错误文案或 null。 */
export function titleProblem(raw: string): string | null {
  const length = Array.from(trimmedTitle(raw)).length;
  return length < 1 || length > MAX_TITLE ? L4.errTitleLength : null;
}

/** 把 Section 接口错误转成中文提示。 */
export function describeSectionError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'invalid_title') return L4.errTitleLength;
    if (error.code === 'duplicate_title') return L4.errTitleDuplicate;
    if (error.code === 'section_limit') return L4.errSectionLimit;
    if (error.code === 'has_nodes') {
      const count = Number(error.details?.count ?? 0);
      return L4.errHasNodes(count);
    }
  }
  return describeError(error);
}

export function ruleViolations(error: unknown): RuleViolation[] | null {
  if (!(error instanceof ApiError) || error.code !== 'rule_violations') return null;
  const raw = error.details?.violations;
  return Array.isArray(raw) ? (raw as RuleViolation[]) : [];
}

export function fetchSections(signal: AbortSignal): Promise<SectionAdminItem[]> {
  return get<SectionAdminItem[]>('sections', {}, { signal });
}

/** Section 变更后：树（Left_Tree）与 Section 列表立即重取。 */
export function afterSectionWrite(): void {
  invalidate('sections');
  invalidate('tree');
}

export const sectionApi = {
  create: (title: string) => post('section-create', { title: trimmedTitle(title) }),
  rename: (id: string, title: string) => post('section-rename', { id, title: trimmedTitle(title) }),
  reorder: (ids: string[]) => post('section-reorder', { ids }),
  remove: (id: string) => post('section-delete', { id }),
  setRule: (id: string, enabled: boolean) => post('section-rule-set', { id, enabled }),
};

/** 把列表中第 index 项向上 / 下移动一位后的 id 顺序；越界返回 null。 */
export function movedOrder(ids: string[], index: number, delta: -1 | 1): string[] | null {
  const target = index + delta;
  if (target < 0 || target >= ids.length) return null;
  const next = ids.slice();
  const [item] = next.splice(index, 1);
  if (item === undefined) return null;
  next.splice(target, 0, item);
  return next;
}

// ---- File Hub ----
export function fetchFiles(trash: boolean, signal: AbortSignal): Promise<HubFile[]> {
  return getJson<HubListing>(`/api/file-hub?folder=&q=&trash=${trash ? 1 : 0}`, { signal }).then((data) =>
    data.files.slice().sort((a, b) => a.path.localeCompare(b.path)),
  );
}

export function fetchDetail(id: string, signal?: AbortSignal): Promise<HubDetail> {
  return getJson<HubDetail>(`/api/file-hub/detail?id=${encodeURIComponent(id)}`, signal ? { signal } : {});
}

export async function fetchRefs(ids: string[], signal?: AbortSignal): Promise<FileRefs> {
  const merged: FileRefs = {};
  for (let start = 0; start < ids.length; start += REF_CHUNK) {
    const chunk = ids.slice(start, start + REF_CHUNK);
    Object.assign(merged, await get<FileRefs>('file-refs', { ids: chunk.join(',') }, signal ? { signal } : {}));
  }
  return merged;
}

export const hubApi = {
  trash: (file: HubFile, confirm: boolean) =>
    postFileHub({ action: 'trash', id: file.id, revision: file.revision, confirm }),
  restore: (file: HubFile) => postFileHub({ action: 'restore', id: file.id, revision: file.revision }),
  uploadVersion: (file: HubFile, blob: File) => {
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
    const query =
      `folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(blob.name)}` +
      `&versionOf=${encodeURIComponent(file.id)}&revision=${file.revision}`;
    return postBinary(`/api/file-hub/upload?${query}`, blob, 'application/octet-stream', { timeoutMs: 300_000 });
  },
};

export function tooLarge(file: { size: number }): boolean {
  return file.size > MAX_FILE_BYTES;
}

// ---- 备份 / 验证 / 切换 ----
export function fetchIntegrity(withBackup: boolean, signal?: AbortSignal): Promise<IntegrityView> {
  return get<IntegrityView>(
    'integrity',
    withBackup ? { backup: 1 } : {},
    { timeoutMs: withBackup ? LONG_TIMEOUT_MS : 30_000, ...(signal ? { signal } : {}) },
  );
}

export const adminApi = {
  backup: () => post<{ path: string; sha256: string }>('backup-create', {}, { timeoutMs: LONG_TIMEOUT_MS }),
  verify: () => post<BackupVerifyReport>('backup-verify', {}, { timeoutMs: LONG_TIMEOUT_MS }),
  switchRoot: () => post('shell-switch', {}, { timeoutMs: LONG_TIMEOUT_MS }),
  rollback: () => post('shell-rollback', {}, { timeoutMs: 30_000 }),
};

/** `acceptance_failed` 的 `details.failed`（检查名列表）。 */
export function failedChecks(error: unknown): string[] | null {
  if (!(error instanceof ApiError) || error.code !== 'acceptance_failed') return null;
  const raw = error.details?.failed;
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
}

export function hex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
