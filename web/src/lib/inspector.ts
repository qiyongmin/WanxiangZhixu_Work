// Inspector 的纯逻辑：草稿 ↔ node-update changes、Repeat_Rule / Tag 校验、冲突差异。
import { L, L2 } from './labels';
import type { CurrentNodeView, NodeDTO, NodeUpdateBody, RepeatRule, Status } from './types';

export const MAX_TAGS = 20;
export const MAX_TAG_LEN = 32;
export const MAX_RELATION_LEN = 32;
export const MAX_INTERVAL = 365;

export interface InspectorDraft {
  status: Status;
  priority: string;
  dueDate: string;
  remindAt: string;
  repeat: RepeatRule | null;
  tags: string[];
}

export function draftFromNode(node: NodeDTO): InspectorDraft {
  return {
    status: node.status,
    priority: node.priority ?? '',
    dueDate: node.dueDate ?? '',
    remindAt: node.remindAt ?? '',
    repeat: normalizeRepeat(node.repeat),
    tags: [...node.tags],
  };
}

/** 规范形式：weekly 的星期升序去重；用于比较与提交。 */
export function normalizeRepeat(rule: RepeatRule | null | undefined): RepeatRule | null {
  if (!rule) return null;
  if (rule.type === 'weekly') return { type: 'weekly', days: Array.from(new Set(rule.days)).sort((a, b) => a - b) };
  if (rule.type === 'interval') return { type: 'interval', days: rule.days };
  return { type: rule.type };
}

export function sameRepeat(a: RepeatRule | null, b: RepeatRule | null): boolean {
  return JSON.stringify(normalizeRepeat(a)) === JSON.stringify(normalizeRepeat(b));
}

export function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

export function isDirty(draft: InspectorDraft, base: InspectorDraft): boolean {
  return Object.keys(buildChanges(draft, base)).length > 0;
}

/** 草稿相对基线的差异，作为单次 node-update 的 changes（一条 Revision）。 */
export function buildChanges(draft: InspectorDraft, base: InspectorDraft): NodeUpdateBody['changes'] {
  const changes: NodeUpdateBody['changes'] = {};
  if (draft.status !== base.status) changes.status = draft.status;
  if (draft.priority !== base.priority) changes.priority = draft.priority;
  if (draft.dueDate !== base.dueDate) changes.dueDate = draft.dueDate;
  if (draft.remindAt !== base.remindAt) changes.remindAt = draft.remindAt;
  if (!sameRepeat(draft.repeat, base.repeat)) changes.repeat = normalizeRepeat(draft.repeat);
  if (!sameTags(draft.tags, base.tags)) changes.tags = [...draft.tags];
  return changes;
}

/** Repeat_Rule 的客户端预检（服务端仍是权威）。无效返回中文提示。 */
export function validateRepeat(rule: RepeatRule | null): string | null {
  if (rule === null) return null;
  if (rule.type === 'weekly') {
    const days = rule.days;
    if (days.length < 1 || days.length > 7 || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) {
      return L2.repeatWeeklyInvalid;
    }
  }
  if (rule.type === 'interval') {
    if (!Number.isInteger(rule.days) || rule.days < 1 || rule.days > MAX_INTERVAL) return L2.repeatIntervalInvalid;
  }
  return null;
}

/** 单个 Tag：NFC + trim 后 1–32 个字符；返回清洗结果或中文提示。 */
export function cleanTag(raw: string): { tag: string } | { error: string } {
  const tag = raw.normalize('NFC').trim();
  const length = Array.from(tag).length;
  if (length < 1 || length > MAX_TAG_LEN) return { error: L2.tagTooLong };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(tag)) return { error: L2.tagTooLong };
  return { tag };
}

export function addTag(tags: readonly string[], raw: string): { tags: string[] } | { error: string } {
  const cleaned = cleanTag(raw);
  if ('error' in cleaned) return cleaned;
  if (tags.includes(cleaned.tag)) return { tags: [...tags] };
  if (tags.length >= MAX_TAGS) return { error: L2.tagTooMany };
  return { tags: [...tags, cleaned.tag] };
}

/** 保存前的整体校验；键为字段名（与服务端 details.fields 一致）。 */
export function validateDraft(draft: InspectorDraft, isTask: boolean): Record<string, string> {
  const errors: Record<string, string> = {};
  const repeatProblem = validateRepeat(draft.repeat);
  if (repeatProblem) errors.repeat = repeatProblem;
  else if (draft.repeat && draft.dueDate === '') errors.repeat = L2.repeatNeedsDue;
  if (!isTask && draft.remindAt !== '') errors.remindAt = L2.taskOnly;
  if (!isTask && draft.repeat) errors.repeat = L2.taskOnly;
  if (draft.tags.length > MAX_TAGS) errors.tags = L2.tagTooMany;
  return errors;
}

export function validateRelation(raw: string): string | null {
  const length = Array.from(raw.trim()).length;
  return length >= 1 && length <= MAX_RELATION_LEN ? null : L2.linkRelationInvalid;
}

export interface StatusDiff {
  mine: Status;
  current: Status;
}

/** 冲突时仅 Status 与草稿有关；其余字段显示当前 Revision 即可。 */
export function conflictDiff(draft: InspectorDraft, base: InspectorDraft, current: CurrentNodeView | undefined): StatusDiff | null {
  if (!current || draft.status === base.status) return null;
  return draft.status === current.status ? null : { mine: draft.status, current: current.status };
}

export const SAVE_LABELS = { saved: L.saved, failed: L.saveFailed } as const;
