"""Section resolution, Section_Rule kernel and Section CRUD (Phase 4).

The read side is pure functions over an open SQLite connection (``sqlite3.Row``
rows); it does not know who the Actor is: the same rule check is used for the
user channel and the Agent channel (Req 2.5). The write side (``section_*``,
bottom of the file) runs each change plus its ``work_section_audit`` row in one
``store.tx`` transaction, so an audit failure rolls the change back.
"""
from __future__ import annotations

import json
import unicodedata
import uuid

import work_hub_schema as schema
import work_hub_store as store

# Section ids seeded by ``work_migrate`` (fixed so INSERT OR IGNORE is idempotent).
SEC_INITIATIVES = "sec-initiatives"
SEC_TEAM = "sec-team-management"
SEC_KNOWLEDGE = "sec-knowledge"
SEC_PROJECTS = "sec-projects"
UNCLASSIFIED_ID = "sec-unclassified"
UNCLASSIFIED = {"id": UNCLASSIFIED_ID, "title": "未归类", "sortOrder": 10 ** 6,
                "itemKind": None, "rules": {}, "virtual": True}

SEED_SECTIONS = (
    # (id, title, sort_order, item_kind, rules)
    (SEC_INITIATIVES, "Initiatives", 1, "initiative", {}),
    (SEC_TEAM, "Team Management", 2, "topic", {"departmentSummaryOnly": True}),
    (SEC_KNOWLEDGE, "Knowledge", 3, "knowledge_collection", {}),
    (SEC_PROJECTS, "Projects", 4, "initiative", {}),
)

# kind of the *top-level* ancestor -> default Section
DEFAULT_SECTION_BY_KIND = {
    "initiative": SEC_INITIATIVES,
    "topic": SEC_TEAM,
    "campaign": SEC_TEAM,
    "knowledge_collection": SEC_KNOWLEDGE,
}
TOP_LEVEL_KINDS = ("initiative", "knowledge_collection", "topic")
TREE_KINDS = ("initiative", "knowledge_collection", "topic", "workstream", "campaign",
              "task", "action")
NON_TREE_KINDS = ("material", "milestone", "risk", "decision")

RULE_KEYS = ("departmentSummaryOnly",)
FORBIDDEN = frozenset({"employees", "employeeIds", "employeeProfiles",
                       "individualReviews", "performanceEvaluations"})
MAX_CHAIN = 200
TOO_DEEP = "<nesting too deep>"
RULE_MESSAGE = "Employee-level data is not allowed"


class SectionRuleViolation(ValueError):
    """Raised when data violates an enabled Section_Rule (HTTP 400)."""

    code = "section_rule_violation"
    status = 400

    def __init__(self, fields, message=RULE_MESSAGE):
        super().__init__(message)
        self.details = {"fields": list(fields)}


# --------------------------------------------------------------------------
# Rule evaluation
# --------------------------------------------------------------------------
def find_forbidden_keys(obj, forbidden=FORBIDDEN, max_depth=50, root="data"):
    """Iteratively find forbidden field names at any nesting level.

    Case-sensitive. Returns ``[{"path": "data.areas[0].employees", "field": "employees"}]``.
    Values nested deeper than ``max_depth`` cannot be inspected, so they are
    reported as a violation as well (fail closed) with ``field == TOO_DEEP``.
    """
    found = []
    stack = [(obj, root, 0)]
    while stack:
        value, path, depth = stack.pop()
        if isinstance(value, dict):
            if depth >= max_depth:
                found.append({"path": path, "field": TOO_DEEP})
                continue
            for key, item in value.items():
                child = f"{path}.{key}"
                if isinstance(key, str) and key in forbidden:
                    found.append({"path": child, "field": key})
                stack.append((item, child, depth + 1))
        elif isinstance(value, (list, tuple)):
            if depth >= max_depth:
                found.append({"path": path, "field": TOO_DEEP})
                continue
            for index, item in enumerate(value):
                stack.append((item, f"{path}[{index}]", depth + 1))
    found.sort(key=lambda hit: (hit["path"], hit["field"]))
    return found


def check_section_rule(data, department_only, forbidden=FORBIDDEN):
    """Single entry point for rule enforcement (user and Agent share it).

    ``department_only`` False/None -> nothing to enforce. True -> reject any
    forbidden field at any level, naming each offending path.
    """
    if not department_only:
        return
    hits = find_forbidden_keys(data, forbidden)
    if hits:
        raise SectionRuleViolation(hits)


# --------------------------------------------------------------------------
# Reading sections
# --------------------------------------------------------------------------
def _rules(raw):
    try:
        value = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _section_dict(row):
    return {"id": row["id"], "title": row["title"], "sortOrder": row["sort_order"],
            "itemKind": row["item_kind"], "rules": _rules(row["rules_json"])}


def list_sections(con):
    return [_section_dict(r) for r in con.execute(
        "SELECT id,title,sort_order,item_kind,rules_json FROM work_sections ORDER BY sort_order,id")]


def get_section(con, section_id):
    if section_id == UNCLASSIFIED_ID:
        return dict(UNCLASSIFIED)
    row = con.execute("SELECT id,title,sort_order,item_kind,rules_json FROM work_sections WHERE id=?",
                      (section_id,)).fetchone()
    return _section_dict(row) if row else None


def section_rules(con, section_id):
    section = get_section(con, section_id) if section_id else None
    return section["rules"] if section else {}


# --------------------------------------------------------------------------
# Effective Section resolution
# --------------------------------------------------------------------------
def _top_ancestor(con, start_id):
    """Walk ``parent_id`` upwards; returns ``(id, kind)`` of the top-level node or None."""
    seen = set()
    current = start_id
    top = None
    while current is not None and current not in seen and len(seen) < MAX_CHAIN:
        seen.add(current)
        row = con.execute("SELECT id,kind,parent_id FROM records WHERE id=?", (current,)).fetchone()
        if row is None:
            break
        top = (row["id"], row["kind"])
        current = row["parent_id"]
    return top


def _resolve_top(con, top_id, top_kind):
    explicit = con.execute("SELECT section_id FROM work_node_section WHERE record_id=?",
                           (top_id,)).fetchone()
    if explicit is not None:
        return explicit["section_id"]
    default = DEFAULT_SECTION_BY_KIND.get(top_kind)
    if default is None:
        return UNCLASSIFIED_ID
    exists = con.execute("SELECT 1 FROM work_sections WHERE id=?", (default,)).fetchone()
    return default if exists else UNCLASSIFIED_ID


def effective_section(con, record_id):
    """Section id of ``record_id``'s top-level ancestor.

    Order: explicit ``work_node_section`` row -> default by kind -> the virtual
    "未归类" group when the default Section no longer exists. Returns ``None`` when
    the record does not exist or is not a tree node (material/milestone/risk/decision).
    """
    top = _top_ancestor(con, record_id)
    if top is None:
        return None
    own = con.execute("SELECT kind FROM records WHERE id=?", (record_id,)).fetchone()
    if own["kind"] in NON_TREE_KINDS:
        return None
    return _resolve_top(con, *top)


def section_of_top(con, top_id, top_kind):
    """Section id of a top-level node given its id and kind (explicit row, else default)."""
    return _resolve_top(con, top_id, top_kind)


def section_for_placement(con, record_id, kind, parent_id):
    """Section a record *would* have if saved with ``parent_id`` (used before a write)."""
    if kind in NON_TREE_KINDS:
        return None
    if isinstance(parent_id, str):
        top = _top_ancestor(con, parent_id)
        if top is not None:
            return _resolve_top(con, *top)
    if not isinstance(record_id, str):
        return _resolve_top(con, "", kind)
    return _resolve_top(con, record_id, kind)


def department_only_for_placement(con, record_id, kind, parent_id):
    """``True/False`` from the Section config, or ``None`` when the DB is not migrated."""
    import work_hub_schema
    if not work_hub_schema.is_migrated(con):
        return None
    section_id = section_for_placement(con, record_id, kind, parent_id)
    if section_id is None:
        return False
    return bool(section_rules(con, section_id).get("departmentSummaryOnly"))


# ==========================================================================
# Section CRUD (Phase 4, Req 2.3 / 2.7-2.11 / 29)
# ==========================================================================
MAX_SECTIONS = 20
MAX_SECTION_TITLE = 50
ORDER_SHIFT = 100000          # two-phase renumbering: avoids transient UNIQUE(sort_order) clashes
AUDIT_ACTOR = "user"          # the request body's actor is ignored, as for every Shell write
ITEM_KINDS = ("initiative", "topic", "knowledge_collection")


class SectionError(ValueError):
    """Section admin failure with the HTTP status / machine code the API layer maps."""

    def __init__(self, message, *, code="invalid_request", status=400, details=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details or {}


def title_key(title):
    return unicodedata.normalize("NFC", title.strip()).casefold()


def _clean_title(value):
    if not isinstance(value, str):
        raise SectionError("Section 标题必须是字符串", code="invalid_title",
                           details={"fields": [{"field": "title", "reason": "必填"}]})
    title = unicodedata.normalize("NFC", value.strip())
    if not 1 <= len(title) <= MAX_SECTION_TITLE:
        raise SectionError("Section 标题需要 1 到 %d 个字符（首尾空白不计）" % MAX_SECTION_TITLE,
                           code="invalid_title",
                           details={"fields": [{"field": "title", "reason": "长度必须为 1–%d" % MAX_SECTION_TITLE}]})
    return title


def _body(body):
    if not isinstance(body, dict):
        raise SectionError("请求体必须是对象", code="invalid_body")
    return body


def _section_id(body):
    value = body.get("id")
    if not isinstance(value, str) or not value:
        raise SectionError("缺少 Section id", code="invalid_id",
                           details={"fields": [{"field": "id", "reason": "必填"}]})
    return value


def _row(con, section_id):
    row = con.execute("SELECT id,title,sort_order,item_kind,rules_json FROM work_sections WHERE id=?",
                      (section_id,)).fetchone()
    if row is None:
        raise SectionError("Section 不存在: %s" % section_id, code="section_not_found", status=404,
                           details={"value": section_id})
    return row


def _assert_unique(con, key, except_id=None):
    row = con.execute("SELECT id FROM work_sections WHERE title_key=?", (key,)).fetchone()
    if row is not None and row["id"] != except_id:
        raise SectionError("已存在同名 Section（忽略大小写与首尾空白）", code="duplicate_title",
                           details={"fields": [{"field": "title", "reason": "重复"}], "existingId": row["id"]})


def _write_audit(con, section_id, op, before, after, now):
    """The single audit write; kept separate so tests can make it fail."""
    con.execute("INSERT INTO work_section_audit(id,section_id,op,before_json,after_json,actor,at) "
                "VALUES(?,?,?,?,?,?,?)",
                (uuid.uuid4().hex, section_id, op,
                 None if before is None else json.dumps(before, ensure_ascii=False, sort_keys=True),
                 None if after is None else json.dumps(after, ensure_ascii=False, sort_keys=True),
                 AUDIT_ACTOR, now))


def _snapshot(row):
    return {"id": row["id"], "title": row["title"], "sortOrder": row["sort_order"],
            "itemKind": row["item_kind"], "rules": _rules(row["rules_json"])}


def _renumber(con, ordered_ids, now):
    """Rewrite sort_order to 1..n in ``ordered_ids`` order (+100000 first, then final values)."""
    con.execute("UPDATE work_sections SET sort_order=sort_order+?", (ORDER_SHIFT,))
    for position, section_id in enumerate(ordered_ids, start=1):
        con.execute("UPDATE work_sections SET sort_order=?,updated_at=? WHERE id=?",
                    (position, now, section_id))


def _all(con):
    return list_sections(con)


def _members(con, section_id):
    """Undeleted tree nodes (archived included) whose effective Section is ``section_id``.

    Returns ``[(node_id, data_json, [titles top->node])]``; same membership rule as
    ``nodes.sections_view().nodeCount``.
    """
    rows = {r["id"]: r for r in con.execute("SELECT id,kind,parent_id,title,data,deleted_at FROM records")}
    explicit = {r[0]: r[1] for r in con.execute("SELECT record_id,section_id FROM work_node_section")}
    existing = {r[0] for r in con.execute("SELECT id FROM work_sections")}
    found = []
    for node_id, row in rows.items():
        if row["deleted_at"] or row["kind"] not in TREE_KINDS:
            continue
        chain, seen, current = [], set(), node_id
        while current in rows and current not in seen and len(seen) < MAX_CHAIN:
            seen.add(current)
            chain.append(current)
            current = rows[current]["parent_id"]
        chain.reverse()
        top = chain[0]
        resolved = explicit.get(top)
        if resolved is None:
            default = DEFAULT_SECTION_BY_KIND.get(rows[top]["kind"])
            resolved = default if default in existing else UNCLASSIFIED_ID
        if resolved == section_id:
            found.append((node_id, row["data"], [rows[i]["title"] for i in chain]))
    return found


def _node_path(section_title, titles):
    return "/".join(s.replace("\\", "\\\\").replace("/", "\\/") for s in [section_title] + titles)


def _writer(path):
    return store.tx(path)


def _require_migrated(con):
    schema.require_migrated(con)


def section_create(body, path=None):
    body = _body(body)
    title = _clean_title(body.get("title"))
    item_kind = body.get("itemKind", "initiative")
    if item_kind not in ITEM_KINDS:
        raise SectionError("itemKind 无效", code="invalid_itemKind",
                           details={"fields": [{"field": "itemKind", "reason": "不支持"}]})
    with _writer(path) as con:
        _require_migrated(con)
        count = con.execute("SELECT COUNT(*) FROM work_sections").fetchone()[0]
        if count >= MAX_SECTIONS:
            raise SectionError("Section 数量已达上限 %d" % MAX_SECTIONS, code="section_limit",
                               details={"limit": MAX_SECTIONS})
        key = title_key(title)
        _assert_unique(con, key)
        now = store._now()
        section_id = "sec-" + uuid.uuid4().hex[:12]
        order = (con.execute("SELECT COALESCE(MAX(sort_order),0) FROM work_sections").fetchone()[0] or 0) + 1
        if order > ORDER_SHIFT:                     # defensive: stay inside 1..n
            order = count + 1
        con.execute("INSERT INTO work_sections(id,title,title_key,sort_order,item_kind,rules_json,"
                    "created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                    (section_id, title, key, order, item_kind, "{}", now, now))
        _renumber(con, [r[0] for r in con.execute("SELECT id FROM work_sections ORDER BY sort_order,id")], now)
        created = _snapshot(_row(con, section_id))
        _write_audit(con, section_id, "create", None, created, now)
        return {"section": created, "sections": _all(con)}


def section_rename(body, path=None):
    body = _body(body)
    section_id = _section_id(body)
    title = _clean_title(body.get("title"))
    with _writer(path) as con:
        _require_migrated(con)
        row = _row(con, section_id)
        before = _snapshot(row)
        key = title_key(title)
        _assert_unique(con, key, except_id=section_id)
        now = store._now()
        con.execute("UPDATE work_sections SET title=?,title_key=?,updated_at=? WHERE id=?",
                    (title, key, now, section_id))
        after = _snapshot(_row(con, section_id))
        _write_audit(con, section_id, "rename", before, after, now)
        return {"section": after, "sections": _all(con)}


def section_reorder(body, path=None):
    body = _body(body)
    ids = body.get("ids")
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise SectionError("ids 必须是 Section id 列表", code="invalid_ids",
                           details={"fields": [{"field": "ids", "reason": "必须是字符串列表"}]})
    with _writer(path) as con:
        _require_migrated(con)
        current = [r["id"] for r in con.execute("SELECT id FROM work_sections ORDER BY sort_order,id")]
        if len(set(ids)) != len(ids) or sorted(ids) != sorted(current):
            raise SectionError("ids 必须恰好包含全部 Section，且不能重复", code="invalid_ids",
                               details={"fields": [{"field": "ids", "reason": "必须是现有 Section 的一个排列"}]})
        before = {r["id"]: r["sort_order"] for r in con.execute("SELECT id,sort_order FROM work_sections")}
        now = store._now()
        _renumber(con, ids, now)
        for position, section_id in enumerate(ids, start=1):
            if before[section_id] != position:
                _write_audit(con, section_id, "reorder", {"sortOrder": before[section_id]},
                             {"sortOrder": position}, now)
        return {"sections": _all(con)}


def section_delete(body, path=None):
    body = _body(body)
    section_id = _section_id(body)
    with _writer(path) as con:
        _require_migrated(con)
        row = _row(con, section_id)
        members = _members(con, section_id)
        if members:
            raise SectionError("该 Section 下仍有 %d 个节点（含已归档），不能删除" % len(members),
                               code="has_nodes", details={"count": len(members)})
        before = _snapshot(row)
        now = store._now()
        con.execute("DELETE FROM work_node_section WHERE section_id=?", (section_id,))
        con.execute("DELETE FROM work_sections WHERE id=?", (section_id,))
        _renumber(con, [r[0] for r in con.execute("SELECT id FROM work_sections ORDER BY sort_order,id")], now)
        _write_audit(con, section_id, "delete", before, None, now)
        return {"deleted": section_id, "sections": _all(con)}


def section_rule_set(body, path=None):
    body = _body(body)
    section_id = _section_id(body)
    enabled = body.get("enabled")
    if not isinstance(enabled, bool):
        raise SectionError("enabled 必须是布尔值", code="invalid_enabled",
                           details={"fields": [{"field": "enabled", "reason": "必须是 true 或 false"}]})
    with _writer(path) as con:
        _require_migrated(con)
        row = _row(con, section_id)
        before = _snapshot(row)
        if enabled:
            violations = []
            for node_id, raw, titles in _members(con, section_id):
                try:
                    data = json.loads(raw) if raw else {}
                except (TypeError, ValueError):
                    data = {}
                for hit in find_forbidden_keys(data):
                    violations.append({"nodeId": node_id, "field": hit["field"],
                                       "nodePath": _node_path(row["title"], titles)})
            if violations:
                violations.sort(key=lambda v: (v["nodePath"], v["nodeId"], v["field"]))
                raise SectionError("该 Section 下有 %d 处数据违反规则，规则保持关闭" % len(violations),
                                   code="rule_violations", details={"violations": violations})
        rules = dict(before["rules"])
        if enabled:
            rules["departmentSummaryOnly"] = True
        else:
            rules.pop("departmentSummaryOnly", None)
        now = store._now()
        con.execute("UPDATE work_sections SET rules_json=?,updated_at=? WHERE id=?",
                    (json.dumps(rules, sort_keys=True), now, section_id))
        after = _snapshot(_row(con, section_id))
        _write_audit(con, section_id, "rule-set", before, after, now)
        return {"section": after, "sections": _all(con)}
