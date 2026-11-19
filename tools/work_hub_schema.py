"""Work Hub v2 schema: additive ``work_*`` tables, indexes and migration state.

The four legacy tables (records / revisions / links / proposals) are never
altered here. ``DDL`` is idempotent (``IF NOT EXISTS``) and is executed by
``work_migrate.migrate`` inside one transaction. Nothing is back-filled.
"""
from __future__ import annotations

SCHEMA_VERSION = 2

TABLES = (
    "work_meta", "work_sections", "work_section_audit", "work_node_section",
    "work_task_ext", "work_tags", "work_recurrences", "work_agent_writes",
    "work_proposal_meta",
)
INDEXES = (
    "work_sections_title", "work_sections_order", "work_ext_remind", "work_tags_tag",
    "work_aw_state", "work_aw_record", "work_aw_actor",
)
LEGACY_TABLES = ("records", "revisions", "links", "proposals")

DDL = [
    """CREATE TABLE IF NOT EXISTS work_meta(
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS work_sections(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  item_kind TEXT NOT NULL DEFAULT 'initiative',
  rules_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    "CREATE UNIQUE INDEX IF NOT EXISTS work_sections_title ON work_sections(title_key)",
    "CREATE UNIQUE INDEX IF NOT EXISTS work_sections_order ON work_sections(sort_order)",
    """CREATE TABLE IF NOT EXISTS work_section_audit(
  id TEXT PRIMARY KEY, section_id TEXT NOT NULL, op TEXT NOT NULL,
  before_json TEXT, after_json TEXT, actor TEXT NOT NULL, at TEXT NOT NULL)""",
    """CREATE TABLE IF NOT EXISTS work_node_section(
  record_id TEXT PRIMARY KEY REFERENCES records(id),
  section_id TEXT NOT NULL REFERENCES work_sections(id))""",
    """CREATE TABLE IF NOT EXISTS work_task_ext(
  record_id TEXT PRIMARY KEY REFERENCES records(id),
  remind_at TEXT,
  repeat_rule TEXT,
  handled_for TEXT,
  handled_at TEXT, handled_action TEXT)""",
    "CREATE INDEX IF NOT EXISTS work_ext_remind ON work_task_ext(remind_at) WHERE remind_at IS NOT NULL",
    """CREATE TABLE IF NOT EXISTS work_tags(
  record_id TEXT NOT NULL REFERENCES records(id), tag TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(record_id, tag))""",
    "CREATE INDEX IF NOT EXISTS work_tags_tag ON work_tags(tag)",
    """CREATE TABLE IF NOT EXISTS work_recurrences(
  source_id TEXT NOT NULL REFERENCES records(id), source_revision INTEGER NOT NULL,
  new_id TEXT NOT NULL REFERENCES records(id), created_at TEXT NOT NULL,
  PRIMARY KEY(source_id, source_revision))""",
    """CREATE TABLE IF NOT EXISTS work_agent_writes(
  write_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL REFERENCES records(id),
  op TEXT NOT NULL,
  ref TEXT,
  actor TEXT NOT NULL, source TEXT NOT NULL,
  node_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  before_json TEXT,
  state TEXT NOT NULL DEFAULT 'unconfirmed',
  created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT, resolved_revision INTEGER)""",
    "CREATE INDEX IF NOT EXISTS work_aw_state ON work_agent_writes(state, created_at)",
    "CREATE INDEX IF NOT EXISTS work_aw_record ON work_agent_writes(record_id, state)",
    "CREATE INDEX IF NOT EXISTS work_aw_actor ON work_agent_writes(actor, created_at)",
    """CREATE TABLE IF NOT EXISTS work_proposal_meta(
  proposal_id TEXT PRIMARY KEY REFERENCES proposals(id),
  proposer TEXT NOT NULL, decided_by TEXT, decided_at TEXT, decision TEXT,
  reason TEXT, applied_revision INTEGER)""",
]


class MigrationRequired(RuntimeError):
    """Raised by ``require_migrated``; the API maps it to HTTP 409."""

    code = "migration_required"
    status = 409

    def __init__(self, message="数据库尚未升级到 v2，请先执行迁移"):
        super().__init__(message)


def _objects(con):
    return {row[0] for row in con.execute(
        "SELECT name FROM sqlite_master WHERE type IN ('table','index')")}


def schema_version(con) -> int:
    """Stored ``schema_version`` or 0 (also 0 when ``work_meta`` is absent/garbled)."""
    if "work_meta" not in _objects(con):
        return 0
    row = con.execute("SELECT value FROM work_meta WHERE key='schema_version'").fetchone()
    if row is None:
        return 0
    try:
        return int(row[0])
    except (TypeError, ValueError):
        return 0


def missing_objects(con) -> list:
    present = _objects(con)
    return [name for name in TABLES + INDEXES if name not in present]


def is_migrated(con) -> bool:
    """True when ``schema_version >= 2`` and every ``work_*`` table/index exists."""
    return schema_version(con) >= SCHEMA_VERSION and not missing_objects(con)


def require_migrated(con) -> None:
    if not is_migrated(con):
        raise MigrationRequired()
