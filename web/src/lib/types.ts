// 与 tools/work_hub_nodes.py / work_hub_api.py 的 DTO 形状一一对应（设计第 3、5 节）。

export const STATUSES = ['Planned', 'In Progress', 'Waiting', 'Blocked', 'Done'] as const;
export type Status = (typeof STATUSES)[number];

export const OPEN_STATUSES = ['Planned', 'In Progress', 'Waiting', 'Blocked'] as const;
export type OpenStatus = (typeof OPEN_STATUSES)[number];

export const TABS = ['overview', 'tasks', 'notes', 'materials', 'activity'] as const;
export type TabId = (typeof TABS)[number];

export type NodeKind =
  | 'initiative'
  | 'knowledge_collection'
  | 'topic'
  | 'workstream'
  | 'campaign'
  | 'task'
  | 'action';

export type Theme = 'light' | 'dark' | 'system';

/** `view=tree` 的 Section（含虚拟「未归类」）。 */
export interface TreeSection {
  id: string;
  title: string;
  sortOrder: number;
  itemKind: string | null;
  rules: Record<string, unknown>;
  nodeCount: number;
  open: number;
  remind: boolean;
  unconfirmed: number;
  virtual?: boolean;
}

/** `view=tree` 的节点：只含可见（自身与祖先均未归档/删除）的树节点。 */
export interface TreeNode {
  id: string;
  parentId: string | null;
  kind: NodeKind;
  displayKind: string;
  title: string;
  status: Status;
  revision: number;
  updatedAt: string;
  depth: number;
  sectionId: string;
  open: number;
  remind: boolean;
  unconfirmed: number;
}

export interface TreeView {
  sections: TreeSection[];
  nodes: TreeNode[];
  generatedAt: string;
}

export interface BackupStatus {
  ok: boolean;
  newest: string | null;
  ageHours: number | null;
  reason: string | null;
}

export interface SchemaView {
  version: number;
  migrated: boolean;
  backup: BackupStatus;
  shellRoot: 'shell' | 'legacy';
}

export interface PathItem {
  id: string;
  title: string;
}

export interface NodeLink {
  relation: string;
  otherId: string;
  otherTitle: string;
  direction: 'out' | 'in';
}

export interface NodeBackRef {
  relation: string;
  sourceId: string;
  sourceTitle: string;
}

export type ResourceLinkKind = 'folder' | 'sharepoint' | 'eridoc' | 'teams' | 'link';
export interface ResourceLink {
  id: string;
  kind: ResourceLinkKind;
  title: string;
  target: string;
}

export interface NodeDTO {
  id: string;
  kind: NodeKind;
  displayKind: string;
  parentId: string | null;
  title: string;
  status: Status;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
  depth: number;
  overDepth: boolean;
  sectionId: string | null;
  path: PathItem[];
  nodePath: string;
  description: string;
  /** Human-owned Task assignee. Empty when not set. */
  assignee?: string;
  /** Historical structured values are preserved, with string keys editable separately. */
  customFields?: Record<string, unknown>;
  /** L1-only shortcuts to local host folders and enterprise web destinations. */
  resourceLinks?: ResourceLink[];
  priority: string | null;
  dueDate: string | null;
  // Phase 2/3 占位字段：后端已返回，当前阶段只读取不编辑。
  remindAt: string | null;
  remindPending: boolean;
  repeat: RepeatRule | null;
  tags: string[];
  summary: { text: string; html: string };
  stats: { open: number; byStatus: Record<OpenStatus, number> };
  childCount: number;
  unconfirmed: Array<Record<string, unknown>>;
  links: NodeLink[];
  backRefs: NodeBackRef[];
}

export interface ChildItem {
  id: string;
  kind: NodeKind;
  displayKind: string;
  title: string;
  status: Status;
  revision: number;
  updatedAt: string;
  childCount: number;
  open: number;
  /** Tasks under (and including) this child: done / total, for the progress bar. */
  taskTotal?: number;
  taskDone?: number;
}

export interface RemovedItem {
  id: string;
  kind: NodeKind;
  displayKind: string;
  title: string;
  state: 'archived' | 'deleted';
  at: string;
  revision: number;
  parentTitle: string | null;
}

export interface RemovedView {
  items: RemovedItem[];
  total: number;
}

export interface ChildrenView {
  items: ChildItem[];
  total: number;
}

export interface ActivityItem {
  revision: number;
  actor: string;
  source: string;
  occurredAt: string;
  changeLabel: string;
  agentWrite: Record<string, unknown> | null;
}

export interface ActivityView {
  items: ActivityItem[];
  nextBefore: number | null;
}

export interface NodeResult {
  node: NodeDTO;
}

export interface BackupResult {
  path: string;
  sha256: string;
  files: number;
  bytes: number;
}

export type MigrationReport = Record<string, unknown>;

/** 409 revision_conflict 响应中的 `current`（节点精简视图）。 */
export interface CurrentNodeView {
  title: string;
  status: Status;
  description: string;
  revision: number;
}

export interface FieldProblem {
  field: string;
  reason: string;
}

// ---- 写入请求 ----
export interface NodeCreateBody {
  kind: string;
  parentId?: string | null;
  sectionId?: string;
  title: string;
  description?: string;
}

export interface NodeUpdateBody {
  id: string;
  baseRevision: number;
  changes: {
    title?: string;
    status?: Status;
    description?: string;
    resourceLinks?: ResourceLink[];
    priority?: string;
    /** 空字符串清除。 */
    dueDate?: string;
    /** 空字符串清除。 */
    remindAt?: string;
    /** `null` 清除。 */
    repeat?: RepeatRule | null;
    tags?: string[];
    assignee?: string;
    /** Key-level patch; null deletes one key without losing unrelated legacy data. */
    customFields?: Record<string, string | null>;
  };
}

export interface NodeMoveBody {
  id: string;
  baseRevision: number;
  parentId: string | null;
}

export interface NodeLifecycleBody {
  id: string;
  baseRevision: number;
  operation: 'archive' | 'unarchive' | 'delete' | 'restore';
}

export interface SummarySetBody {
  id: string;
  baseRevision: number;
  text: string;
}

// ---- Phase 2：任务、提醒、Cockpit、搜索、标签 ----
export const PRIORITIES = ['Urgent', 'High', 'Medium', 'Low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export type RepeatRule =
  | { type: 'daily' }
  | { type: 'weekly'; days: number[] }
  | { type: 'monthly' }
  | { type: 'interval'; days: number };
/** `view=tasks` / 提醒 / Cockpit 的行（设计 4.16 TaskRow）。 */
export interface TaskRow {
  id: string;
  kind: NodeKind;
  title: string;
  status: Status;
  priority: string | null;
  dueDate: string | null;
  assignee?: string;
  remindAt: string | null;
  remindPending: boolean;
  repeat: RepeatRule | null;
  tags: string[];
  parentId: string | null;
  path: PathItem[];
  sectionId: string | null;
  revision: number;
  openChildCount: number;
  unconfirmed: number;
  updatedAt: string | null;
  lastActivityAt?: string;
  /** Card counts (additive; absent on older payloads): sub-tasks, notes and linked materials. */
  subtaskTotal?: number;
  subtaskDone?: number;
  noteCount?: number;
  materialCount?: number;
}
export interface TasksView {
  items: TaskRow[];
  total: number;
}
export const COCKPIT_GROUPS = ['overdue', 'today', 'week', 'reminders', 'followUp', 'recent'] as const;
export type CockpitGroupId = (typeof COCKPIT_GROUPS)[number];
export type CockpitGroupData = { ok: true; total: number; items: TaskRow[] } | { ok: false; error: string };
export type CockpitView = { clock: { today: string; now: string } } & Partial<Record<CockpitGroupId, CockpitGroupData>>;
export interface RemindersView {
  due: TaskRow[];
  upcoming: TaskRow[];
}
export interface SearchHit {
  id: string;
  title: string;
  kind: NodeKind;
  sectionId: string;
  sectionTitle: string;
  nodePath: string;
  matchedIn: string[];
  snippet: string;
}
export interface TagCount {
  tag: string;
  count: number;
}
export interface TagNode {
  id: string;
  title: string;
  kind: NodeKind;
  sectionId: string;
  sectionTitle: string;
}
export interface LinkBody {
  sourceId: string;
  targetId: string;
  relation: string;
}

// ---- Phase 3：Notes、资料、Summary 历史、Agent 写入、提案 ----
export interface NoteEntry {
  id: string;
  title: string;
  html: string;
}
export interface NotesView {
  items: NoteEntry[];
  /** Note id -> time of the last persisted edit to this particular Note, from immutable Revisions. */
  modifiedAt?: Record<string, string>;
  legacyNotes: string;
  /** 仅有旧 `data.notes` 时由服务端合成的「Note 1」（不写库）。 */
  legacyNote?: { id: string; title: string; legacy: true; html: string };
  /** noteId → writeId：尚未确认的 Agent 写入。 */
  unconfirmed?: Record<string, string>;
}
export interface MaterialItem {
  id: string;
  title: string;
  createdAt?: string | number | null;
  materialType: string;
  url: string | null;
  fileId: string | null;
  missing: boolean;
  format: 'md' | 'html' | null;
  origin: string | null;
  unconfirmed: string | null;
  name?: string;
  size?: number;
  /** Derived File Hub document metadata, never persisted into Work material records. */
  displayName?: string;
  businessVersion?: string | null;
  pinnedRevision?: number | null;
  /** Relationship to the source task/workstream (e.g. plan, evidence, deliverable). */
  purpose?: string;
  scope?: 'direct' | 'workstream' | 'campaign' | 'initiative' | 'topic' | 'knowledge_collection' | 'task' | 'action';
  sourceNodeId?: string;
  sourceTitle?: string;
  sourceLevel?: number;
  sourceKind?: string;
  description?: string;
  tags?: string[];
  fileRevision?: number;
  fileUpdatedAt?: number;
  publishedVersion?: string | null;
  usedBy?: Array<{ nodeId: string; title: string; purpose: string }>;
}
export interface FileHubRef {
  createdAt?: string | number | null;
  fileId: string;
  name: string;
  path: string;
  size: number;
  relation: string;
  missing: boolean;
  purpose?: string;
  description?: string;
  tags?: string[];
  fileRevision?: number;
  fileUpdatedAt?: number;
  sourceNodeId?: string;
  sourceTitle?: string;
  sourceLevel?: number;
  sourceKind?: string;
}
export interface MaterialsView {
  items: MaterialItem[];
  inherited?: MaterialItem[];
  lineage?: Array<{ id: string; title: string; kind: string; level?: number }>;
  fileHubRefs?: FileHubRef[];
  inheritedFileHubRefs?: FileHubRef[];
  total?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
  legacy?: boolean;
}
export interface SummaryHistoryItem {
  revision: number;
  actor: string;
  source: string;
  occurredAt: string;
  text: string;
  isCurrent: boolean;
  rollbackable: boolean;
}
export interface NoteImageResult {
  fileId: string;
  mime: string;
  size: number;
  url: string;
}
export interface UnconfirmedWrite {
  writeId: string;
  op: string;
  ref: string;
  actor: string;
  createdAt: string;
}
export type WriteState = 'unconfirmed' | 'confirmed' | 'undone' | 'approved';
export interface AgentWriteRow {
  writeId: string;
  actor: string;
  nodeId: string;
  nodePath: string | null;
  op: string;
  createdAt: string;
  state: WriteState;
  resolvedAt: string | null;
}
export interface AgentWritesView {
  items: AgentWriteRow[];
  nextCursor: string | null;
}
export interface ProposalDTO {
  id: string;
  nodeId: string;
  status: string;
  proposer: string | null;
  rationale: string;
  evidence: string[];
  baseRevision: number;
  createdAt: string;
  changes?: Record<string, unknown>;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  nodeTitle?: string | null;
  nodePath?: string | null;
  currentRevision?: number | null;
  stale?: boolean;
}
export interface ProjectSkill {
  id: string;
  name: string;
  description: string;
  status?: string;
}
export interface AgentWriteResult {
  write: { writeId: string; state: WriteState };
  node: NodeDTO;
}

// ---- Phase 4：Section 管理、File Hub 管理、备份验证与切换 ----
/** `view=sections` 的一项（虚拟「未归类」带 `virtual: true`，不可管理）。 */
export interface SectionAdminItem {
  id: string;
  title: string;
  sortOrder: number;
  itemKind: string | null;
  rules: Record<string, unknown>;
  nodeCount: number;
  virtual?: boolean;
}

export interface RuleViolation {
  nodeId: string;
  nodePath: string;
  field: string;
}

/** `/api/file-hub` 列表中的一个文件。 */
export interface HubFile {
  created?: number;
  updated?: number;
  id: string;
  path: string;
  name: string;
  sha: string;
  size: number;
  revision: number;
  deleted: number;
  displayName?: string;
  businessVersion?: string | null;
  tags?: string[];
}

export interface HubListing {
  files: HubFile[];
}

export interface HubVersion {
  file_id: string;
  revision: number;
  sha: string;
  size: number;
  source: string;
  locked: number;
  at: number | null;
}

export interface HubDetail extends HubFile {
  versions: HubVersion[];
}

export interface FileRef {
  nodeId: string;
  title: string;
}

export type FileRefs = Record<string, FileRef[]>;

export type CheckStatus = 'pass' | 'fail' | 'pending';

export interface AcceptanceCheck {
  name: 'records_visible' | 'revisions_match' | 'files_verified' | 'backup_verified';
  label: string;
  status: CheckStatus;
  ok: boolean;
  detail: string;
}

export interface BackupVerifyRow {
  category: 'records' | 'revisions' | 'links' | 'files';
  label: string;
  source: number;
  restored: number;
  match: boolean;
}

export interface BackupVerifyFailure {
  category: string;
  label: string;
  reason: string;
}

export interface BackupVerifyReport {
  passed: boolean;
  fresh: boolean;
  archive: string | null;
  ageHours: number | null;
  rows: BackupVerifyRow[];
  failures: BackupVerifyFailure[];
}

export interface IntegrityView {
  counts: { records: number; revisions: number; links: number; files: number };
  checks: AcceptanceCheck[];
  backup: BackupVerifyReport | null;
  shellRoot: 'shell' | 'legacy';
  accepted: boolean;
}
