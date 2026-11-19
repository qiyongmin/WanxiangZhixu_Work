"""Work Hub v2 node views and basic write actions (Phase 1).

Plain functions; HTTP routing lives in ``work_hub_api`` (task 13). Every v2 read
and write first checks ``schema.require_migrated`` (409 ``migration_required``
on an un-migrated database). Writes run through ``store.tx`` and
``store._save_record_tx`` / ``store._lifecycle_tx`` so each action writes exactly
one Revision, with actor fixed to ``user`` and source ``shell:<action>``; any
``actor`` in a request body is ignored.

Views : sections, tree, node, children, activity
Actions: node_create, node_update, node_move, node_lifecycle, summary_set

Fields that belong to Phase 2/3 are present in the DTOs as placeholders
(``remindAt``, ``remindPending``, ``repeat``, ``tags``, ``unconfirmed``,
tree ``remind`` / ``unconfirmed``) and filled in by the tasks that own them.
"""
from __future__ import annotations

import contextlib
import copy
import datetime as _dt
import html
import html.parser
import importlib
import json
import os
import re
import sqlite3
import unicodedata
import uuid

import work_hub_ext as ext
import work_hub_html
import work_hub_notes
import work_hub_paths as paths
import work_hub_schema as schema
import work_hub_sections as sections
import work_hub_store as store
import work_shortcuts

ACTOR = "user"
MAX_TITLE = 200
MAX_DESCRIPTION = 10000
MAX_LIMIT = 100
DEFAULT_CHILDREN_LIMIT = 50
DEFAULT_ACTIVITY_LIMIT = 50
OPEN_STATUSES = ("Planned", "In Progress", "Waiting", "Blocked")
TASK_KINDS = ("task", "action")
UPDATABLE_FIELDS = ("title", "status", "description", "priority", "dueDate", "remindAt", "repeat", "tags", "assignee", "customFields", "resourceLinks")
TASK_ONLY_FIELDS = ("remindAt", "repeat")
DISPLAY_KIND = {
    "task": "Task", "action": "Task", "initiative": "Initiative", "topic": "Topic",
    "knowledge_collection": "Knowledge Collection", "workstream": "Workstream",
    "campaign": "Campaign",
}
OPERATIONS = ("archive", "unarchive", "delete", "restore")
PARENT_REQUIRED_KINDS = ("task", "action", "workstream", "campaign")
# Only these structural child kinds are creatable. Keep other root Item
# types in their Section and never expose legacy Action as a new kind.
CREATE_CHILD_PARENTS = {
    "workstream": ("initiative", "knowledge_collection"),
    "campaign": ("topic",),
    "task": ("initiative", "knowledge_collection", "workstream", "topic",
             "campaign", "task", "action"),
}
PATH_MAX_LEN = 2048
PATH_MAX_SEGMENTS = 5     # Section title + at most 4 levels
PATH_SEGMENT_MAX = 300
MAX_CANDIDATES = 50


# --------------------------------------------------------------------------
# Errors (each carries the HTTP status and machine code the API layer needs)
# --------------------------------------------------------------------------
class NodeError(ValueError):
    status = 400
    code = "invalid_request"

    def __init__(self, message, *, code=None, status=None, details=None, extra=None):
        super().__init__(message)
        if code:
            self.code = code
        if status:
            self.status = status
        self.details = details or {}
        self.extra = extra or {}

    def payload(self):
        body = {"ok": False, "error": str(self), "code": self.code}
        if self.details:
            body["details"] = self.details
        body.update(self.extra)
        return body


class NodeNotFound(NodeError):
    status = 404
    code = "node_not_found"

    def __init__(self, value=None, message=None):
        super().__init__(message or ("节点不存在: %s" % (value,)), details={"value": value})


class PathError(NodeError):
    code = "invalid_path"

    def __init__(self, category, position):
        super().__init__("Node_Path 无效（%s，位置 %d）" % (category, position),
                         details={"category": category, "position": position})
        self.category = category
        self.position = position


class RevisionConflict(NodeError):
    status = 409
    code = "revision_conflict"

    def __init__(self, current_revision, current):
        super().__init__("版本冲突：当前 Revision 为 %s，请重新加载后再保存" % current_revision,
                         extra={"currentRevision": current_revision, "current": current})
        self.current_revision = current_revision
        self.current = current


def _fields_error(fields, message=None):
    """400 with one ``{field, reason}`` entry per invalid field."""
    fields = [{"field": f, "reason": r} for f, r in fields]
    first = fields[0]["field"]
    return NodeError(message or "字段无效: " + "; ".join("%s（%s）" % (f["field"], f["reason"]) for f in fields),
                     code="invalid_" + first, details={"fields": fields})


# --------------------------------------------------------------------------
# Node_Path (minimal grammar for view=node; design 4.14)
# --------------------------------------------------------------------------
def parse_node_path(text):
    """Split an escaped Node_Path into segments (``\\/`` -> ``/``, ``\\\\`` -> ``\\``)."""
    try:
        return paths.parse(text)          # grammar lives in work_hub_paths
    except paths.PathError as exc:
        raise PathError(exc.category, exc.position) from None


def format_node_path(segments):
    return paths.format(segments)


def _key(text):
    return unicodedata.normalize("NFC", text).casefold()


# --------------------------------------------------------------------------
# Connections and request parsing
# --------------------------------------------------------------------------
@contextlib.contextmanager
def _reader(path):
    with store._lock, contextlib.closing(store._connection(path)) as con:
        schema.require_migrated(con)
        yield con


@contextlib.contextmanager
def _writer(path):
    with store.tx(path) as con:
        schema.require_migrated(con)
        yield con


def _body(body):
    if not isinstance(body, dict):
        raise NodeError("请求体必须是对象", code="invalid_body")
    return body


def _int_param(value, name, default, low, high):
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        raise _fields_error([(name, "必须是整数")])
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise _fields_error([(name, "必须是整数")]) from None
    if not low <= number <= high:
        raise _fields_error([(name, "必须在 %d 到 %d 之间" % (low, high))])
    return number


def _base_revision(body):
    if "baseRevision" not in body or body["baseRevision"] is None:
        raise NodeError("缺少 baseRevision", code="base_revision_required",
                        details={"fields": [{"field": "baseRevision", "reason": "必填"}]})
    value = body["baseRevision"]
    if type(value) is not int or value < 1:
        raise _fields_error([("baseRevision", "必须是正整数")])
    return value


def _node_id(body, key="id"):
    value = body.get(key)
    if not isinstance(value, str) or not value:
        raise _fields_error([(key, "必填，且必须是字符串")])
    return value


def _reject_multiple_parents(body):
    if any(k in body for k in store.MULTI_PARENT_KEYS):
        raise store._multiple_parents()


def _validate_title(value):
    if not isinstance(value, str) or not value.strip():
        return None, "不能为空"
    if len(value.strip()) > MAX_TITLE:
        return None, "不能超过 %d 个字符" % MAX_TITLE
    return value.strip(), None


def _validate_description(value):
    if not isinstance(value, str):
        return None, "必须是文本"
    if len(value) > MAX_DESCRIPTION:
        return None, "不能超过 %d 个字符" % MAX_DESCRIPTION
    return value, None


# --------------------------------------------------------------------------
# In-memory index over the whole table (one scan; no JSON decoding)
# --------------------------------------------------------------------------
class _Index:
    COLUMNS = "id,kind,parent_id,title,status,revision,created_at,updated_at,archived_at,deleted_at"

    def __init__(self, con):
        self.rows = {r["id"]: dict(r) for r in con.execute("SELECT %s FROM records" % self.COLUMNS)}
        self.children = {}
        for row in sorted(self.rows.values(), key=lambda r: (r["created_at"], r["id"])):
            self.children.setdefault(row["parent_id"], []).append(row["id"])
        self._top_cache = {}

    def is_tree(self, row):
        return row["kind"] in sections.TREE_KINDS

    def chain(self, node_id):
        """Ids from the top-level ancestor down to ``node_id`` (cycle-safe)."""
        ids, seen, current = [], set(), node_id
        while current is not None and current in self.rows and current not in seen:
            seen.add(current)
            ids.append(current)
            current = self.rows[current]["parent_id"]
        ids.reverse()
        return ids

    def top(self, node_id):
        chain = self.chain(node_id)
        return chain[0] if chain else None

    def roots(self):
        return [i for i, r in self.rows.items()
                if r["parent_id"] is None or r["parent_id"] not in self.rows]

    def active_children(self, node_id):
        """Tree-kind children that are neither archived nor deleted, in creation order."""
        return [c for c in self.children.get(node_id, ())
                if self.is_tree(self.rows[c]) and not self.rows[c]["archived_at"]
                and not self.rows[c]["deleted_at"]]

    def descendants(self, node_id):
        """Active descendants (iterative; never enters archived/deleted subtrees)."""
        found, stack = [], list(reversed(self.active_children(node_id)))
        seen = {node_id}
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            found.append(current)
            stack.extend(reversed(self.active_children(current)))
        return found

    def stats(self, node_id):
        by_status = {s: 0 for s in OPEN_STATUSES}
        for child in self.descendants(node_id):
            row = self.rows[child]
            if row["kind"] in TASK_KINDS and row["status"] in by_status:
                by_status[row["status"]] += 1
        return {"open": sum(by_status.values()), "byStatus": by_status}


def _local_minute():
    """Server wall-clock at minute precision (module-level so tests can pin it)."""
    return ext.local_minute()


def _pending_reminder_ids(con, now_minute):
    """Ids of non-deleted, non-Done tasks whose reminder is due and unhandled (design 4.7)."""
    return {r[0] for r in con.execute(
        """SELECT e.record_id FROM work_task_ext e JOIN records r ON r.id=e.record_id
           WHERE e.remind_at IS NOT NULL AND e.remind_at<=? AND (e.handled_for IS NULL OR e.handled_for!=e.remind_at)
             AND r.status!='Done' AND r.deleted_at IS NULL""", (now_minute,))}


def _section_lookup(con):
    found = {s["id"]: s for s in sections.list_sections(con)}
    found[sections.UNCLASSIFIED_ID] = dict(sections.UNCLASSIFIED)
    return found


def _top_sections(con, index):
    """``{top_level_id: section_id}`` for every tree-kind root."""
    return {i: sections.section_of_top(con, i, index.rows[i]["kind"])
            for i in index.roots() if index.is_tree(index.rows[i])}


def _node_section(index, top_map, node_id):
    top = index.top(node_id)
    return top_map.get(top)


def _row_or_404(con, node_id, *, allow_deleted=False):
    row = con.execute("SELECT * FROM records WHERE id=?", (node_id,)).fetchone()
    if row is None or (row["deleted_at"] and not allow_deleted):
        raise NodeNotFound(node_id)
    return row


# --------------------------------------------------------------------------
# Views
# --------------------------------------------------------------------------
def sections_view(path=None):
    """``[{id,title,sortOrder,itemKind,rules,nodeCount}]``.

    ``nodeCount`` counts every non-deleted tree node of the Section (archived
    ones included), i.e. exactly what blocks deleting that Section.
    """
    with _reader(path) as con:
        return _sections_with_counts(con, _Index(con))


def _sections_with_counts(con, index):
    top_map = _top_sections(con, index)
    counts = {}
    for node_id, row in index.rows.items():
        if row["deleted_at"] or not index.is_tree(row):
            continue
        section_id = _node_section(index, top_map, node_id)
        if section_id is not None:
            counts[section_id] = counts.get(section_id, 0) + 1
    result = [{**s, "nodeCount": counts.get(s["id"], 0)} for s in sections.list_sections(con)]
    if counts.get(sections.UNCLASSIFIED_ID):
        result.append({**sections.UNCLASSIFIED, "nodeCount": counts[sections.UNCLASSIFIED_ID]})
    return result


# --------------------------------------------------------------------------
# Sibling-only navigation order (metadata, NEVER a node_move / reparent).
# --------------------------------------------------------------------------
def _nav_order_key(parent_id, section_id=None):
    return "tree-order:node:" + parent_id if parent_id else "tree-order:section:" + section_id


def _ordered_siblings(con, ids, key):
    """Apply saved rank to current visible siblings, append newly created/restored IDs."""
    row = con.execute("SELECT value FROM work_meta WHERE key=?", (key,)).fetchone()
    if not row:
        return list(ids)
    try:
        saved = json.loads(row[0])
    except (TypeError, ValueError):
        return list(ids)
    if not isinstance(saved, list):
        return list(ids)
    present = set(ids)
    seen = set()
    ranked = []
    for ident in saved:
        if isinstance(ident, str) and ident in present and ident not in seen:
            ranked.append(ident)
            seen.add(ident)
    return ranked + [ident for ident in ids if ident not in seen]


def node_reorder(body, path=None):
    """Atomically reorder *existing siblings* under the same parent (or L1 Section).

    No parent_id/section ownership, IDs, Notes, Materials, URL or Work Node
    revisions are rewritten. expectedIds is a compare-and-swap precondition.
    Section ordering has its own separate 'section-reorder' action.
    """
    body = _body(body)
    ids, expected = body.get("ids"), body.get("expectedIds")
    parent = body.get("parentId")
    section_id = body.get("sectionId")
    if not isinstance(ids, list) or not isinstance(expected, list) or any(
        not isinstance(item, str) or not item for item in ids + expected
    ) or len(ids) != len(expected) or not 2 <= len(ids) <= 2000 or len(set(ids)) != len(ids):
        raise _fields_error([("ids", "需要无重复的同层兄弟节点完整排列")])
    if parent is not None and (not isinstance(parent, str) or not parent):
        raise _fields_error([("parentId", "必须是有效父节点 ID")])
    if parent is None and (not isinstance(section_id, str) or not section_id):
        raise _fields_error([("sectionId", "L1 需要所属 Section ID")])
    with _writer(path) as con:
        index = _Index(con)
        if parent is None:
            top_map = _top_sections(con, index)
            visible = [node_id for node_id in index.roots()
                       if index.is_tree(index.rows[node_id])
                       and not index.rows[node_id]["archived_at"]
                       and not index.rows[node_id]["deleted_at"]
                       and top_map.get(node_id) == section_id]
            visible.sort(key=lambda ident: (index.rows[ident]["created_at"], ident))
            key = _nav_order_key(None, section_id)
        else:
            parent_row = index.rows.get(parent)
            if not parent_row or not index.is_tree(parent_row) or parent_row["deleted_at"] or parent_row["archived_at"]:
                raise NodeNotFound(parent)
            visible = index.active_children(parent)
            if len(index.chain(parent)) >= 3:
                raise NodeError("只允许 L1/L2/L3 排序", code="reorder_level")
            key = _nav_order_key(parent)
        current = _ordered_siblings(con, visible, key)
        if current != expected:
            raise NodeError("顺序已在其他窗口改变，请刷新后重试", status=409,
                            code="reorder_conflict", extra={"currentIds": current})
        if sorted(ids) != sorted(current):
            raise NodeError("只允许同一父节点中的兄弟节点互换位置", code="reorder_scope")
        if ids == current:
            return {"ids": current, "changed": False}
        stamp = store._now()
        con.execute("INSERT INTO work_meta(key,value,updated_at) VALUES(?,?,?) "
                    "ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
                    (key, json.dumps(ids, ensure_ascii=False), stamp))
        # Append-only metadata audit. Does not touch business revisions.
        con.execute("INSERT INTO work_meta(key,value,updated_at) VALUES(?,?,?)",
                    ("tree-order-audit:" + uuid.uuid4().hex,
                     json.dumps({"scope": key, "before": current, "after": ids,
                                 "actor": ACTOR}, ensure_ascii=False), stamp))
        return {"ids": ids, "changed": True}


def tree_view(path=None, now=None):
    """``{sections, nodes, generatedAt}``: Sections plus every visible tree node.

    Visible = tree kind, and neither the node nor any ancestor archived/deleted.
    ``open`` counts Tasks (self included) that are not Done; ``remind`` and
    ``unconfirmed`` are Phase 2/3 placeholders.
    """
    with _reader(path) as con:
        index = _Index(con)
        top_map = _top_sections(con, index)
        section_list = _sections_with_counts(con, index)
        order = {s["id"]: s["sortOrder"] for s in section_list}
        roots = [i for i in index.roots() if index.is_tree(index.rows[i])
                 and not index.rows[i]["archived_at"] and not index.rows[i]["deleted_at"]]
        roots.sort(key=lambda i: (order.get(top_map[i], 10 ** 9), index.rows[i]["created_at"], i))
        root_groups = {}
        for ident in roots:
            root_groups.setdefault(top_map[ident], []).append(ident)
        roots = [ident for sec in sorted(root_groups, key=lambda sid: (order.get(sid, 10 ** 9), sid))
                 for ident in _ordered_siblings(con, root_groups[sec], _nav_order_key(None, sec))]
        nodes, open_count = [], {}
        stack = [(r, 1, top_map[r]) for r in reversed(roots)]
        seen = set()
        while stack:
            node_id, depth, section_id = stack.pop()
            if node_id in seen:
                continue
            seen.add(node_id)
            row = index.rows[node_id]
            nodes.append({
                "id": node_id, "parentId": row["parent_id"], "kind": row["kind"],
                "displayKind": DISPLAY_KIND.get(row["kind"], row["kind"]), "title": row["title"],
                "status": row["status"], "revision": row["revision"], "updatedAt": row["updated_at"],
                "depth": depth, "sectionId": section_id, "open": 0, "remind": False, "unconfirmed": 0,
            })
            for child in reversed(_ordered_siblings(con, index.active_children(node_id), _nav_order_key(node_id))):
                stack.append((child, depth + 1, section_id))
        by_id = {n["id"]: n for n in nodes}
        pending_ids = _pending_reminder_ids(con, ext.minute_now(now) or _local_minute())
        remind_count, unconfirmed_count = {}, {}
        own_unconfirmed = _unconfirmed_counts(con)
        for node in reversed(nodes):                        # children come after parents in DFS order
            own = 1 if node["kind"] in TASK_KINDS and node["status"] != "Done" else 0
            open_count[node["id"]] = open_count.get(node["id"], 0) + own
            remind_count[node["id"]] = remind_count.get(node["id"], 0) + (1 if node["id"] in pending_ids else 0)
            unconfirmed_count[node["id"]] = unconfirmed_count.get(node["id"], 0) + own_unconfirmed.get(node["id"], 0)
            parent = node["parentId"]
            if parent in by_id:
                open_count[parent] = open_count.get(parent, 0) + open_count[node["id"]]
                remind_count[parent] = remind_count.get(parent, 0) + remind_count[node["id"]]
                unconfirmed_count[parent] = unconfirmed_count.get(parent, 0) + unconfirmed_count[node["id"]]
            node["open"] = open_count[node["id"]]
            node["remind"] = remind_count[node["id"]] > 0
            node["unconfirmed"] = unconfirmed_count[node["id"]]
        section_open, section_remind, section_unconfirmed = {}, set(), {}
        for node in nodes:
            if node["parentId"] not in by_id:
                section_open[node["sectionId"]] = section_open.get(node["sectionId"], 0) + node["open"]
                section_unconfirmed[node["sectionId"]] = \
                    section_unconfirmed.get(node["sectionId"], 0) + node["unconfirmed"]
                if node["remind"]:
                    section_remind.add(node["sectionId"])
        for section in section_list:
            section["open"] = section_open.get(section["id"], 0)
            section["remind"] = section["id"] in section_remind
            section["unconfirmed"] = section_unconfirmed.get(section["id"], 0)
        return {"sections": section_list, "nodes": nodes, "generatedAt": now or store._now()}


def _resolve_node_path(con, index, top_map, section_map, segments):
    section_ids = [sid for sid, s in section_map.items() if _key(s["title"]) == _key(segments[0])]
    if len(segments) < 2:        # a bare Section title addresses the Section, not a node
        return []
    wanted = _key(segments[1])
    frontier = [i for i, sid in top_map.items()
                if sid in section_ids and not index.rows[i]["deleted_at"]
                and _key(index.rows[i]["title"]) == wanted]
    for segment in segments[2:]:
        wanted = _key(segment)
        frontier = [c for n in frontier for c in index.children.get(n, ())
                    if index.is_tree(index.rows[c]) and not index.rows[c]["deleted_at"]
                    and _key(index.rows[c]["title"]) == wanted]
    return sorted(set(frontier))


def _node_path_segments(index, section_map, top_map, node_id):
    chain = index.chain(node_id)
    section = section_map.get(top_map.get(chain[0]) if chain else None)
    return [section["title"] if section else sections.UNCLASSIFIED["title"]] + \
           [index.rows[i]["title"] for i in chain]


def node_view(id=None, node_path=None, path=None):  # noqa: A002 (mirrors the ?id= parameter)
    """NodeDTO for ``id`` and/or an escaped Node_Path. 404 for missing or deleted nodes."""
    if id is None and node_path is None:
        raise NodeError("需要 id 或 path", code="locator_required")
    with _reader(path) as con:
        index = _Index(con)
        top_map = _top_sections(con, index)
        section_map = _section_lookup(con)
        found = None
        if id is not None:
            found = _row_or_404(con, id)["id"]
        if node_path is not None:
            matches = _resolve_node_path(con, index, top_map, section_map, parse_node_path(node_path))
            if not matches:
                raise NodeNotFound(node_path)
            if len(matches) > 1:
                raise NodeError("路径匹配多个节点", code="ambiguous_path", status=409, details={
                    "candidates": [{"id": m, "nodePath": format_node_path(
                        _node_path_segments(index, section_map, top_map, m))}
                        for m in matches[:MAX_CANDIDATES]]})
            if found is not None and found != matches[0]:
                raise NodeError("id 与 path 指向不同的节点", code="locator_conflict")
            found = matches[0]
        return _node_dto(con, index, section_map, top_map, found)


def _summary_of(data):
    block = data.get("summaryBlock")
    if isinstance(block, dict) and isinstance(block.get("text"), str) and isinstance(block.get("html"), str):
        return {"text": block["text"], "html": block["html"]}
    return {"text": "", "html": ""}


def _description_of(data):
    value = data.get("description")
    return value if isinstance(value, str) else ""


def _str_or_none(value):
    return value if isinstance(value, str) else None


def _node_dto(con, index, section_map, top_map, node_id, allow_deleted=False):
    row = _row_or_404(con, node_id, allow_deleted=allow_deleted)
    record = store._serialize(row)
    data = record["data"] if isinstance(record["data"], dict) else {}
    chain = index.chain(node_id)
    depth = len(chain)
    segments = _node_path_segments(index, section_map, top_map, node_id)
    side = ext.get_ext(con, node_id)
    links = [{"relation": r["relation"], "otherId": r["target_id"], "otherTitle": r["title"], "direction": "out"}
             for r in con.execute(
                 """SELECT l.relation,l.target_id,r.title FROM links l JOIN records r ON r.id=l.target_id
                    WHERE l.source_id=? AND r.deleted_at IS NULL AND NOT (l.relation='reference' AND r.kind='material')
                    ORDER BY l.relation,r.title,l.target_id""", (node_id,))]
    back_refs = [{"relation": r["relation"], "sourceId": r["source_id"], "sourceTitle": r["title"]}
                 for r in con.execute(
                     """SELECT l.relation,l.source_id,r.title FROM links l JOIN records r ON r.id=l.source_id
                        WHERE l.target_id=? AND r.deleted_at IS NULL AND NOT (l.relation='reference' AND r.kind='material')
                        ORDER BY l.relation,r.title,l.source_id""", (node_id,))]
    return {
        "id": node_id, "kind": record["kind"],
        "displayKind": DISPLAY_KIND.get(record["kind"], record["kind"]),
        "parentId": record["parent_id"], "title": record["title"], "status": record["status"],
        "revision": record["revision"], "createdAt": record["created_at"], "updatedAt": record["updated_at"],
        "archivedAt": record["archived_at"], "deletedAt": record["deleted_at"],
        "depth": depth, "overDepth": depth > store.MAX_DEPTH,
        "sectionId": top_map.get(chain[0]) if chain else None,
        "path": [{"id": i, "title": index.rows[i]["title"]} for i in chain[:-1]],
        "nodePath": format_node_path(segments),
        "description": _description_of(data),
        "assignee": _str_or_none(data.get("assignee")) or "",
        "customFields": data.get("customFields") if isinstance(data.get("customFields"), dict) else {},
        "resourceLinks": data.get("resourceLinks") if isinstance(data.get("resourceLinks"), list) else [],
        "priority": _str_or_none(data.get("priority")),
        "dueDate": _str_or_none(data.get("dueDate")) or None,
        "remindAt": side["remind_at"],
        "remindPending": ext.pending(side["remind_at"], side["handled_for"], record["status"], _local_minute()),
        "repeat": side["repeat"], "tags": ext.get_tags(con, node_id),
        "summary": _summary_of(data),
        "stats": index.stats(node_id),
        "childCount": len(index.active_children(node_id)),
        "unconfirmed": _unconfirmed_of(con, node_id),
        "links": links, "backRefs": back_refs,
    }


def children_view(id, limit=None, offset=None, path=None):  # noqa: A002
    """``{items, total}``: visible direct children in creation order."""
    limit = _int_param(limit, "limit", DEFAULT_CHILDREN_LIMIT, 1, MAX_LIMIT)
    offset = _int_param(offset, "offset", 0, 0, 10 ** 9)
    with _reader(path) as con:
        _row_or_404(con, id)
        index = _Index(con)
        ids = index.active_children(id)
        items = []
        for child in ids[offset:offset + limit]:
            row = index.rows[child]
            group = [child] + index.descendants(child)
            tasks_in = [t for t in group if index.rows[t]["kind"] in TASK_KINDS]
            done = sum(1 for t in tasks_in if index.rows[t]["status"] == "Done")
            items.append({"id": child, "kind": row["kind"], "displayKind": DISPLAY_KIND.get(row["kind"], row["kind"]),
                          "title": row["title"], "status": row["status"], "revision": row["revision"],
                          "updatedAt": row["updated_at"], "childCount": len(index.active_children(child)),
                          "open": index.stats(child)["open"]
                          + (1 if row["kind"] in TASK_KINDS and row["status"] != "Done" else 0),
                          # additive progress counts (task descendants including the child itself)
                          "taskTotal": len(tasks_in), "taskDone": done})
        return {"items": items, "total": len(ids)}


REMOVED_LIMIT = 200


def removed_view(path=None):
    """``{items, total}``: tree nodes that are archived or deleted themselves (newest first, <= 200).

    Read-only; restoring goes through ``node-lifecycle`` (``unarchive`` / ``restore``).
    """
    with _reader(path) as con:
        index = _Index(con)
        rows = [r for r in index.rows.values()
                if index.is_tree(r) and (r["archived_at"] or r["deleted_at"])]
        rows.sort(key=lambda r: (r["deleted_at"] or r["archived_at"], r["id"]), reverse=True)
        items = []
        for r in rows[:REMOVED_LIMIT]:
            parent = index.rows.get(r["parent_id"]) if r["parent_id"] else None
            items.append({"id": r["id"], "kind": r["kind"], "displayKind": DISPLAY_KIND.get(r["kind"], r["kind"]),
                          "title": r["title"], "state": "deleted" if r["deleted_at"] else "archived",
                          "at": r["deleted_at"] or r["archived_at"], "revision": r["revision"],
                          "parentTitle": parent["title"] if parent else None})
        return {"items": items, "total": len(rows)}


MAX_READONLY_MATERIALS = 200


def _note_modified_times(con, node_id, entries, legacy=False):
    """Last persisted change to each Note, derived from immutable Revisions.

    No timestamp is invented from the enclosing Task's updated_at, since that
    also changes for status, metadata, and other Notes. No storage migration.
    """
    latest = {}
    wanted = {entry["id"] for entry in entries}
    if legacy:
        wanted.add(LEGACY_NOTE_ID)
    if not wanted:
        return latest
    for revision in con.execute(
        "SELECT before_json,after_json,occurred_at FROM revisions "
        "WHERE record_id=? ORDER BY revision DESC", (node_id,)
    ):
        if not wanted:
            break
        before = _loads(revision["before_json"]) or {}
        after = _loads(revision["after_json"]) or {}
        old_data = before.get("data") if isinstance(before.get("data"), dict) else {}
        new_data = after.get("data") if isinstance(after.get("data"), dict) else {}
        def as_map(data):
            raw = data.get("noteEntries")
            return {e["id"]: (e.get("title"), e.get("html"))
                    for e in raw if isinstance(e, dict) and isinstance(e.get("id"), str)
                    } if isinstance(raw, list) else {}
        old_entries = as_map(old_data)
        new_entries = as_map(new_data)
        for note_id in list(wanted):
            changed = (old_data.get("notes") != new_data.get("notes")
                       if note_id == LEGACY_NOTE_ID else old_entries.get(note_id) != new_entries.get(note_id))
            if changed and (note_id == LEGACY_NOTE_ID or note_id in new_entries):
                latest[note_id] = revision["occurred_at"]
                wanted.remove(note_id)
    return latest


def notes_view(id, path=None):  # noqa: A002
    """Read-only notes of a node: ``{items: [{id,title,html}], legacyNotes}`` (Phase 1 notes tab)."""
    with _reader(path) as con:
        row = _row_or_404(con, id)
        data = store._serialize(row)["data"]
        data = data if isinstance(data, dict) else {}
        entries = data.get("noteEntries")
        items = [{"id": str(e.get("id", "")), "title": str(e.get("title", "")), "html": str(e.get("html", ""))}
                 for e in (entries if isinstance(entries, list) else []) if isinstance(e, dict)]
        legacy = data.get("notes")
        legacy = legacy if isinstance(legacy, str) else ""
        result = {"items": items, "legacyNotes": legacy}
        # Additive read-only metadata: stored noteEntries remain exactly
        # {id,title,html}; old clients and Revision snapshots stay compatible.
        result["modifiedAt"] = _note_modified_times(
            con, id, items, legacy=bool(legacy.strip() and "noteEntries" not in data))
        if legacy.strip() and "noteEntries" not in data:
            # A node that only has the old plain-text ``data.notes`` reads as "Note 1" (Req 19.13);
            # nothing is rewritten in the database.
            result["legacyNote"] = {"id": LEGACY_NOTE_ID, "title": "Note 1", "legacy": True,
                                    "html": "<p>%s</p>" % html.escape(legacy, quote=False).replace("\n", "<br>")}
        unconfirmed = {w["ref"]: w["writeId"] for w in _unconfirmed_of(con, id) if w["op"] == "add_note"}
        if unconfirmed:
            result["unconfirmed"] = unconfirmed
        return result


LEGACY_NOTE_ID = "note_legacynote"
FILE_ID = re.compile(r"file_[0-9a-f]{32}\Z")


def _file_hub():
    """The ``file_hub`` module, or ``None`` when this process has no isolated File Hub roots.

    Mirrors ``site_boundary``: File Hub is only active after BOTH roots are configured, so
    in-process tests never touch the live catalog (they patch this accessor instead).
    """
    if not (os.environ.get("KB_FILE_HUB_LIBRARY") and os.environ.get("KB_FILE_HUB_DATA")):
        return None
    import file_hub
    return file_hub


def _file_lookup(file_id):
    """``(known, info)``: ``info`` is ``{name,path,size}`` or ``None`` when the file is gone/trashed."""
    hub = _file_hub()
    if hub is None:
        return False, None
    try:
        with contextlib.closing(hub._db()) as hub_con:
            row = hub._file(file_id, hub_con)
    except hub.Missing:
        return True, None
    if row["deleted"]:
        return True, None
    try:
        with contextlib.closing(hub._db()) as hub_con:
            doc = hub_con.execute('SELECT display_name,business_version FROM documents WHERE file_id=?',(file_id,)).fetchone()
    except sqlite3.Error:
        doc = None
    name = str(row['path']).rsplit('/', 1)[-1]
    return True, {'name':name,'path':row['path'],'size':row['size'],
                  'displayName':doc['display_name'] if doc else hub._business_identity(name)[0],
                  'businessVersion':doc['business_version'] if doc else hub._business_identity(name)[1]}


def _local_legacy_extension():
    """Optional private Work data adapters; absent in a generic source clone."""
    try:
        return importlib.import_module("work_local_extensions")
    except ModuleNotFoundError as error:
        if error.name == "work_local_extensions":
            return None
        raise


def _archived_material_source(data):
    """Optional legacy File Hub mapping without publishing instance paths."""
    extension = _local_legacy_extension()
    if extension is None:
        return None
    return extension.archived_material_source(data, _file_hub())


def _material_file_id(data):
    file_id = data.get("fileId")
    if isinstance(file_id, str) and file_id:
        return file_id
    media = data.get("mediaId")
    if isinstance(media, str) and media:
        hub = _file_hub()
        if hub is not None:
            try:
                alias = hub.work_media_alias(media)
            except ValueError:
                alias = None
            if alias:
                return alias["file_id"]
        return media
    return _archived_material_source(data)


def _material_item(row, data, unconfirmed):
    file_id = _material_file_id(data)
    kind = data.get("materialType") or ("file" if file_id else "link" if data.get("url") else "file")
    source = data.get('src')
    source_format = (source.rsplit('.', 1)[-1].lower() if isinstance(source, str) and
                     source.startswith('projects/') and '.' in source else None)
    item = {"id": row["id"], "title": row["title"], "createdAt": row["created_at"], "materialType": str(kind),
            "url": data.get("url") if isinstance(data.get("url"), str) else None,
            "fileId": file_id, "missing": False,
            "format": data.get("format") if data.get("format") in ("md", "html") else
                      source_format if source_format in ('md', 'html') else None,
            "origin": data.get("origin") if isinstance(data.get("origin"), str) else None,
            "description": data.get("description") if isinstance(data.get("description"), str) else "",
            "publishedVersion": data.get("publishedVersion") if isinstance(data.get("publishedVersion"), str) else None,
            "unconfirmed": unconfirmed.get(row["id"])}
    if file_id and FILE_ID.match(file_id):
        known, info = _file_lookup(file_id)
        if known and info is None:
            item["missing"] = True          # stale reference: kept and flagged (Req 20.10)
        elif info:
            item.update(name=info['name'], size=info['size'],
                        displayName=info.get('displayName') or info['name'],
                        businessVersion=info.get('businessVersion'))
            hub=_file_hub()
            if hub is not None and hasattr(hub,'pinned_material_version'):
                try:
                    item['pinnedRevision']=hub.pinned_material_version(file_id,row['id'])
                except (OSError,sqlite3.Error,ValueError):
                    item['pinnedRevision']=None
    return item


def _direct_file_refs(kind, node_id):
    """File Hub files linked straight to the node (``note-image`` provenance excluded)."""
    hub = _file_hub()
    if hub is None or kind not in sections.TREE_KINDS:
        return []
    try:
        rows = hub.linked_context(kind, node_id)
    except (ValueError, OSError, sqlite3.Error):
        return []
    return [{"fileId": r["id"], "name": str(r["path"]).rsplit("/", 1)[-1], "path": r["path"],
             "size": r["size"], "createdAt": r.get("created"),
             "relation": r["link_relation"], "missing": bool(r["deleted"])}
            for r in rows if r.get("link_relation") != "note-image"]


def materials_view(id, path=None, max_results=MAX_READONLY_MATERIALS):  # noqa: A002
    """Direct materials plus optional project-level lineage (read-only, no file copies).

    ``items`` remains the original direct-material collection for existing clients.
    ``inherited`` is a separate, non-removable Workstream-level context list;
    Initiative-wide documents are deliberately not propagated into every Task.
    """
    with _reader(path) as con:
        node = _row_or_404(con, id)
        index = _Index(con)
        chain = index.chain(id)
        depth_map = {ancestor_id: level for level,ancestor_id in enumerate(chain, 1)}
        # Generic projects may opt into complete lineage explicitly; old local
        # projects keep their previous behavior through an ignored local adapter.
        root_record = con.execute('SELECT data FROM records WHERE id=?',(chain[0],)).fetchone() if chain else None
        root_data = _loads(root_record['data']) if root_record else None
        extended_lineage = bool(root_data and root_data.get('materialsLineage') is True)
        extension = _local_legacy_extension()
        if extension is not None and extension.is_legacy_lineage(chain, index):
            extended_lineage = True
        unconfirmed = {w["ref"]: w["writeId"] for w in _unconfirmed_of(con, id)
                       if w["op"] in ("add_material", "upload_report")}
        items, inherited, seen = [], [], set()

        def linked_materials(source_id, bucket, scope):
            for r in con.execute(
                    """SELECT r.id,r.title,r.data,r.created_at,l.relation FROM links l
                       JOIN records r ON r.id=l.target_id
                       WHERE l.source_id=? AND r.kind='material' AND r.deleted_at IS NULL
                       ORDER BY r.created_at,r.id""", (source_id,)):
                if r['id'] in seen or (max_results is not None and len(items) + len(inherited) >= max_results):
                    continue
                # Original generic contract: only 'reference' links are surfaced,
                # unless explicit project lineage compatibility is enabled.
                if not extended_lineage and r['relation'] != 'reference':
                    continue
                seen.add(r['id'])
                item = _material_item(r, _loads(r['data']) or {}, unconfirmed if scope == 'direct' else {})
                item.update(purpose=r['relation'], scope=scope, sourceNodeId=source_id,
                            sourceLevel=depth_map.get(source_id),
                            sourceKind=index.rows[source_id]['kind'],
                            sourceTitle=index.rows[source_id]['title'])
                if extended_lineage:
                    item['usedBy'] = [
                        {'nodeId': use['source_id'], 'title': use['title'], 'purpose': use['relation']}
                        for use in con.execute(
                            """SELECT l.source_id,n.title,l.relation FROM links l
                               JOIN records n ON n.id=l.source_id
                               WHERE l.target_id=? AND n.deleted_at IS NULL
                               ORDER BY n.title,l.source_id LIMIT 30""", (r['id'],))]
                bucket.append(item)

        linked_materials(id, items, 'direct')
        # All ancestors remain distinguishable by their original L1/L2/L3 owner.
        # These are read-only references, not copies. Closest ancestor comes first.
        inherited_refs=[]
        for parent_id in reversed(chain[:-1]):
            parent=index.rows[parent_id]
            if parent['kind'] not in sections.TREE_KINDS:
                continue
            linked_materials(parent_id, inherited, parent['kind'])
            for ref in _direct_file_refs(parent['kind'],parent_id):
                inherited_refs.append(dict(ref,sourceNodeId=parent_id,
                    sourceTitle=parent['title'],sourceLevel=depth_map[parent_id],
                    sourceKind=parent['kind']))
        lineage = ([{'id': node_id, 'title': index.rows[node_id]['title'],
                     'kind': index.rows[node_id]['kind'], 'level':depth_map[node_id]}
                    for node_id in chain])
        return {'items': items, 'inherited': inherited, 'lineage': lineage,
                'fileHubRefs': _direct_file_refs(node['kind'], id),
                'inheritedFileHubRefs': inherited_refs}


_CHANGE_TYPES = {
    "confirm": "确认 Agent 写入", "undo": "撤销 Agent 写入", "material-add": "添加资料",
    "material-remove": "移除资料", "agent-write": "Agent 写入",
    "recurrence-created": "创建重复任务", "reminder-snooze": "推迟提醒",
}


def _loads(text):
    try:
        value = json.loads(text) if text else None
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def change_label(before, after):
    """Short Chinese description of what one Revision changed (``before`` None = creation)."""
    if before is None:
        return "创建"
    after = after or {}
    change = after.get("_change")
    if isinstance(change, dict) and change.get("type") in _CHANGE_TYPES:
        return _CHANGE_TYPES[change["type"]]
    parts = []
    if before.get("title") != after.get("title"):
        parts.append("修改标题")
    if before.get("status") != after.get("status"):
        parts.append("状态 %s → %s" % (before.get("status"), after.get("status")))
    if before.get("parent_id") != after.get("parent_id"):
        parts.append("移动")
    for column, on, off in (("archived_at", "归档", "取消归档"), ("deleted_at", "删除", "恢复")):
        if bool(before.get(column)) != bool(after.get(column)):
            parts.append(on if after.get(column) else off)
    old = before.get("data") if isinstance(before.get("data"), dict) else {}
    new = after.get("data") if isinstance(after.get("data"), dict) else {}
    handled = {"description": "修改描述", "noteEntries": "更新笔记", "priority": "修改优先级",
               "dueDate": "修改截止日期"}
    for key, label in handled.items():
        if (old.get(key) or None) != (new.get(key) or None):
            parts.append(label)
    old_ext, new_ext = before.get("ext") or {}, after.get("ext") or {}
    for key, label in (("tags", "修改标签"), ("remindAt", "修改提醒"), ("repeat", "修改重复规则")):
        if (old_ext.get(key) or None) != (new_ext.get(key) or None):
            parts.append(label)
    if _summary_of(old)["text"] != _summary_of(new)["text"]:
        parts.append("更新摘要")
    others = (set(old) | set(new)) - set(handled) - {"summaryBlock"}
    if any(old.get(k) != new.get(k) for k in others):
        parts.append("更新内容")
    return "、".join(parts) or "保存"


def activity_view(id, limit=None, before=None, path=None):  # noqa: A002
    """Revisions of a node, newest first: ``{items, nextBefore}``."""
    limit = _int_param(limit, "limit", DEFAULT_ACTIVITY_LIMIT, 1, MAX_LIMIT)
    before = _int_param(before, "before", None, 1, 10 ** 9)
    with _reader(path) as con:
        _row_or_404(con, id)
        sql = "SELECT revision,actor,source,before_json,after_json,occurred_at FROM revisions WHERE record_id=?"
        args = [id]
        if before is not None:
            sql += " AND revision<?"
            args.append(before)
        rows = con.execute(sql + " ORDER BY revision DESC LIMIT ?", args + [limit + 1]).fetchall()
        more = len(rows) > limit
        writes = {}
        for w in con.execute("SELECT write_id,op,ref,actor,state,node_revision,resolved_revision "
                             "FROM work_agent_writes WHERE record_id=?", (id,)):
            info = {"writeId": w["write_id"], "op": w["op"], "ref": w["ref"], "actor": w["actor"],
                    "state": w["state"]}
            writes.setdefault(w["node_revision"], info)
            if w["resolved_revision"] is not None:
                writes.setdefault(w["resolved_revision"], info)
        items = [{"revision": r["revision"], "actor": r["actor"], "source": r["source"],
                  "occurredAt": r["occurred_at"],
                  "changeLabel": change_label(_loads(r["before_json"]), _loads(r["after_json"])),
                  "agentWrite": writes.get(r["revision"])}
                 for r in rows[:limit]]
        return {"items": items, "nextBefore": items[-1]["revision"] if more and items else None}


# --------------------------------------------------------------------------
# Actions
# --------------------------------------------------------------------------
def _dto(con, node_id, allow_deleted=False):
    index = _Index(con)
    return _node_dto(con, index, _section_lookup(con), _top_sections(con, index), node_id,
                     allow_deleted=allow_deleted)


def _current_view(row):
    data = store._serialize(row)["data"]
    return {"title": row["title"], "status": row["status"],
            "description": _description_of(data if isinstance(data, dict) else {}),
            "revision": row["revision"]}


def _check_revision(row, base_revision):
    if row["revision"] != base_revision:
        raise RevisionConflict(row["revision"], _current_view(row))


PROP_KEYS = ("priority", "dueDate", "remindAt", "repeat", "tags")


def _validate_props(changes):
    """Validate the Phase 2 property fields present in ``changes``: ``(clean, problems)``."""
    clean, problems = {}, []
    checks = (("priority", ext.check_priority), ("dueDate", ext.check_due_date),
              ("remindAt", ext.check_remind_at), ("repeat", ext.check_repeat), ("tags", ext.check_tags))
    for key, check in checks:
        if key in changes:
            value, reason = check(changes[key])
            if reason:
                problems.append((key, reason))
            else:
                clean[key] = value
    return clean, problems


def _plan_props(kind, data, current_ext, clean):
    """Apply validated properties to ``data`` (in place) and enforce the cross-field rules.

    Returns ``(data, final_repeat, final_due)``. Nothing is written here.
    """
    if kind not in TASK_KINDS:
        bad = [(key, "只有 Task 支持该属性") for key in TASK_ONLY_FIELDS if clean.get(key)]
        if bad:
            raise _fields_error(bad)
    if "priority" in clean:
        data["priority"] = clean["priority"]
    if "dueDate" in clean:
        data["dueDate"] = clean["dueDate"]
    final_repeat = clean["repeat"] if "repeat" in clean else current_ext["repeat"]
    final_due = data.get("dueDate") if isinstance(data.get("dueDate"), str) else ""
    if final_repeat and not final_due:
        field = "repeat" if clean.get("repeat") else "dueDate"
        raise NodeError("设置重复规则前需先设置 Due_Date", code="invalid_request",
                        details={"fields": [{"field": field, "reason": "需先设置 Due_Date"}]})
    return data, final_repeat, final_due


def _write_side_tables(con, record_id, clean):
    """Persist remind / repeat / tags from validated ``clean`` (caller owns the transaction)."""
    fields = {}
    if "remindAt" in clean:
        fields["remind_at"] = clean["remindAt"]
    if "repeat" in clean:
        fields["repeat_rule"] = clean["repeat"]
    if fields:
        ext.set_ext(con, record_id, **fields)
    if "tags" in clean:
        ext.set_tags(con, record_id, clean["tags"], store._now())


def _save(con, payload, source, extra=None, before_extra=None, actor=ACTOR):
    try:
        with work_hub_notes.relaxed():          # v2 limits; Legacy ``save`` keeps the pinned ones
            if extra or before_extra:
                return store._save_record_tx(con, payload, actor, source, extra=extra, before_extra=before_extra)
            return store._save_record_tx(con, payload, actor, source)
    except store.Conflict:
        row = con.execute("SELECT * FROM records WHERE id=?", (payload.get("id"),)).fetchone()
        if row is None:
            raise NodeNotFound(payload.get("id")) from None
        raise RevisionConflict(row["revision"], _current_view(row)) from None
    except store.NotFound as exc:
        raise NodeNotFound(str(exc), str(exc)) from None


def _payload_for(record, **overrides):
    payload = {"id": record["id"], "kind": record["kind"], "title": record["title"],
               "status": record["status"], "parent_id": record["parent_id"],
               "data": copy.deepcopy(record["data"]), "revision": record["revision"]}
    payload.update(overrides)
    return payload


def _editable(con, node_id, body):
    """Common prologue of update/move/summary: node, revision, current record."""
    base_revision = _base_revision(body)
    row = _row_or_404(con, node_id)
    _check_revision(row, base_revision)
    return store._serialize(row)


def node_create(body, path=None):
    """Create a Section Item or a valid Workstream/Campaign/Task child. Never create Action."""
    body = _body(body)
    _reject_multiple_parents(body)
    kind = body.get("kind")
    parent_id = body.get("parentId")
    section_id = body.get("sectionId")
    problems = []
    title, reason = _validate_title(body.get("title"))
    if reason:
        problems.append(("title", reason))
    description = None
    if body.get("description") is not None:
        description, reason = _validate_description(body["description"])
        if reason:
            problems.append(("description", reason))
    if parent_id is not None and not isinstance(parent_id, str):
        raise store._multiple_parents()
    if section_id is not None and not isinstance(section_id, str):
        problems.append(("sectionId", "必须是字符串"))
    props, prop_problems = _validate_props({k: body[k] for k in PROP_KEYS if body.get(k) is not None})
    problems += prop_problems
    with _writer(path) as con:
        item_kinds = {s["itemKind"] for s in sections.list_sections(con)} - {"action", None}
        if not isinstance(kind, str) or kind not in item_kinds | set(CREATE_CHILD_PARENTS):
            problems.insert(0, ("kind", "只能创建 Section Item、Workstream、Campaign 或 Task"))
        if problems:
            raise _fields_error(problems)
        explicit_section = None
        if parent_id is None:
            if kind in CREATE_CHILD_PARENTS:
                raise NodeError("%s 必须选择父节点" % kind, code="parent_required",
                                details={"fields": [{"field": "parentId", "reason": "必填"}]})
        else:
            if kind not in CREATE_CHILD_PARENTS:
                raise NodeError("顶层 Item 不能嵌套在其他节点之下", code="invalid_parent",
                                details={"fields": [{"field": "parentId", "reason": "Item 必须是顶层节点"}]})
            parent = con.execute("SELECT id,kind,deleted_at FROM records WHERE id=?",
                                 (parent_id,)).fetchone()
            if parent is None or parent["deleted_at"]:
                raise NodeNotFound(parent_id, "父节点不存在: %s" % parent_id)
            if parent["kind"] not in CREATE_CHILD_PARENTS[kind]:
                raise NodeError("该父节点不能创建 %s" % kind, code="invalid_parent",
                                details={"fields": [{"field": "parentId", "reason": "父节点类型不允许"}]})
        if section_id is not None:
            section = sections.get_section(con, section_id)
            if section is None or section["id"] == sections.UNCLASSIFIED_ID:
                raise NodeError("Section 不存在: %s" % section_id, code="section_not_found", status=404,
                                details={"value": section_id})
            if parent_id is not None:
                if sections.effective_section(con, parent_id) != section_id:
                    raise NodeError("sectionId 与父节点所属 Section 不一致", code="section_mismatch",
                                    details={"fields": [{"field": "sectionId", "reason": "与父节点不一致"}]})
            elif section["itemKind"] != kind:
                raise NodeError("该 Section 的 Item 类型是 %s，不能创建 %s" % (section["itemKind"], kind),
                                code="section_kind_mismatch",
                                details={"fields": [{"field": "sectionId", "reason": "Item 类型不匹配"}]})
            elif sections.DEFAULT_SECTION_BY_KIND.get(kind) != section_id:
                explicit_section = section_id
        record_id = "work-" + uuid.uuid4().hex
        if explicit_section:
            # FK is checked at COMMIT so the mapping can precede the record; the Section_Rule
            # check inside the save then already sees the chosen Section.
            con.execute("PRAGMA defer_foreign_keys=ON")
            con.execute("INSERT INTO work_node_section(record_id,section_id) VALUES(?,?)",
                        (record_id, explicit_section))
        data = {"description": description} if description else {}
        if kind == "task":
            data["priority"] = ext.DEFAULT_PRIORITY
        data, _, _ = _plan_props(kind, data, {"repeat": None}, props)
        if data.get("dueDate") == "":
            del data["dueDate"]
        # FK is checked at COMMIT, so the side-table rows may precede the record itself.
        con.execute("PRAGMA defer_foreign_keys=ON")
        _write_side_tables(con, record_id, props)
        after_ext = ext.snapshot(con, record_id)
        saved = _save(con, {"id": record_id, "kind": kind, "title": title, "status": "Planned",
                            "parent_id": parent_id, "data": data, "revision": 0}, "shell:node-create",
                      extra={"ext": after_ext} if after_ext else None)
        created = _dto(con, saved["id"])
        # V3.4 Journal is a protected system Section, initialized with its Node
        # in the same transaction when the additive Notes migration is active.
        import work_notebook_v34 as notebook_v34
        notebook_v34.ensure_journal(con, created["id"])
    result = {"node": created}
    if parent_id is None and kind in ("initiative", "topic", "knowledge_collection"):
        # Work record commits independently; a filesystem failure never leaves a
        # half-created node. The deterministic directory can be retried safely.
        try:
            import work_material_storage
            result["materialStorage"] = work_material_storage.ensure_for_node(created["id"], db_path=path)
        except (OSError, sqlite3.Error, ValueError) as exc:
            result["materialStorage"] = {"ready": False, "error": str(exc), "retryable": True}
    return result


def _validate_task_extras(changes):
    """Validate task-owned manual attributes, without replacing historical fields.

    ``customFields`` is an explicit key-level patch: string sets a value, null
    removes only that key. Other old keys, including structured values, survive.
    """
    clean, problems = {}, []
    if 'assignee' in changes:
        value = changes['assignee']
        if not isinstance(value, str) or len(value.strip()) > 120 or any(ord(c) < 32 for c in value):
            problems.append(('assignee', '必须是 0–120 字符文本'))
        else:
            clean['assignee'] = value.strip()
    if 'customFields' in changes:
        patch = changes['customFields']
        if not isinstance(patch, dict) or len(patch) > 30:
            problems.append(('customFields', '必须是最多 30 项的对象'))
        else:
            valid = {}
            for key, value in patch.items():
                if not isinstance(key, str) or not 1 <= len(key.strip()) <= 80 or key != key.strip() or any(ord(c) < 32 for c in key):
                    problems.append(('customFields', '字段名必须是 1–80 字符且无控制符'))
                    break
                if value is not None and (not isinstance(value, str) or len(value) > 500 or any(ord(c) < 32 and c not in '\\n\\t' for c in value)):
                    problems.append(('customFields', '字段值必须是 0–500 字符文本或 null'))
                    break
                valid[key] = value
            if not problems:
                clean['customFields'] = valid
    return clean, problems


def node_update(body, path=None):
    """Change title, status, task metadata and custom fields in one Revision."""
    body = _body(body)
    node_id = _node_id(body)
    changes = body.get("changes")
    if not isinstance(changes, dict) or not changes:
        raise _fields_error([("changes", "必须是非空对象")])
    unknown = sorted(set(changes) - set(UPDATABLE_FIELDS))
    if unknown:
        raise _fields_error([(k, "不支持修改该字段") for k in unknown])
    problems, clean = [], {}
    if "title" in changes:
        clean["title"], reason = _validate_title(changes["title"])
        problems += [("title", reason)] if reason else []
    if "status" in changes:
        if changes["status"] not in store.STATES:
            problems.append(("status", "必须是 %s 之一" % " / ".join(sorted(store.STATES))))
        clean["status"] = changes["status"]
    if "description" in changes:
        clean["description"], reason = _validate_description(changes["description"])
        problems += [("description", reason)] if reason else []
    if "resourceLinks" in changes:
        try:
            clean["resourceLinks"] = work_shortcuts.validate_resource_links(changes["resourceLinks"])
        except ValueError as exc:
            problems.append(("resourceLinks", str(exc)))
    props, prop_problems = _validate_props(changes)
    extras, extra_problems = _validate_task_extras(changes)
    problems += prop_problems + extra_problems
    if problems:
        raise _fields_error(problems)
    with _writer(path) as con:
        if body.get("idempotent") is True and clean.get("status") == "Done":
            _row_or_404(con, node_id)
            replay = con.execute("SELECT new_id FROM work_recurrences WHERE source_id=? AND source_revision=?",
                                 (node_id, _base_revision(body))).fetchone()
            if replay:
                return {"node": _dto(con, node_id), "createdIds": [replay[0]], "replayed": True}
        record = _editable(con, node_id, body)
        data = copy.deepcopy(record["data"])      # unknown historical keys stay untouched
        if "resourceLinks" in clean:
            if record["kind"] not in work_shortcuts.ROOT_KINDS or record["parent_id"] is not None:
                raise _fields_error([("resourceLinks", "仅一级 Initiative / Topic / Knowledge Collection 可修改快捷入口")])
            data["resourceLinks"] = clean["resourceLinks"]
        if extras and record['kind'] not in TASK_KINDS:
            raise _fields_error([(key, '只有 Task 支持该属性') for key in extras])
        if "description" in clean:
            data["description"] = clean["description"]
        if 'assignee' in extras:
            data['assignee'] = extras['assignee']
        if 'customFields' in extras:
            fields = data.get('customFields')
            fields = dict(fields) if isinstance(fields, dict) else {}
            for key, value in extras['customFields'].items():
                if value is None:
                    fields.pop(key, None)
                else:
                    fields[key] = value
            data['customFields'] = fields
        before_ext = ext.snapshot(con, node_id)
        data, _, _ = _plan_props(record["kind"], data, ext.get_ext(con, node_id), props)
        overrides = {"data": data}
        for key in ("title", "status"):
            if key in clean:
                overrides[key] = clean[key]
        _write_side_tables(con, node_id, props)
        touched = any(key in props for key in ("tags", "remindAt", "repeat"))
        after_ext = ext.snapshot(con, node_id, force=touched)
        saved = _save(con, _payload_for(record, **overrides), "shell:node-update",
                      extra={"ext": after_ext} if after_ext else None,
                      before_extra={"ext": before_ext} if before_ext else None)
        result = {"node": _dto(con, saved["id"])}
        created = con.execute("SELECT new_id FROM work_recurrences WHERE source_id=? AND source_revision=?",
                              (node_id, record["revision"])).fetchone()
        if created and clean.get("status") == "Done":
            result["createdIds"] = [created[0]]
        return result


def node_move(body, path=None):
    """Re-parent a node (``parentId``; ``null`` = top level for Items)."""
    body = _body(body)
    _reject_multiple_parents(body)
    node_id = _node_id(body)
    if "parentId" not in body:
        raise _fields_error([("parentId", "必填")])
    parent_id = body["parentId"]
    if parent_id is not None and not isinstance(parent_id, str):
        raise store._multiple_parents()
    with _writer(path) as con:
        record = _editable(con, node_id, body)
        if parent_id is not None:
            if parent_id == node_id:
                raise store.HierarchyError("hierarchy_cycle", "不允许形成循环层级")
            parent = con.execute("SELECT deleted_at FROM records WHERE id=?", (parent_id,)).fetchone()
            if parent is None or parent["deleted_at"]:
                raise NodeNotFound(parent_id, "父节点不存在: %s" % parent_id)
        if parent_id is None and record["kind"] in PARENT_REQUIRED_KINDS:
            raise NodeError("该类型的节点必须有父节点", code="parent_required",
                            details={"fields": [{"field": "parentId", "reason": "必填"}]})
        if record["parent_id"] != parent_id:
            _check_subtree_rule(con, node_id, parent_id, record["kind"])
        saved = _save(con, _payload_for(record, parent_id=parent_id), "shell:node-move")
        return {"node": _dto(con, saved["id"])}


def _check_subtree_rule(con, node_id, new_parent_id, kind):
    """A moved subtree must satisfy the destination Section_Rule, not just its root node."""
    target = sections.department_only_for_placement(con, node_id, kind, new_parent_id)
    if not target:
        return
    violations = []
    for descendant in _Index(con).descendants(node_id):
        data = json.loads(con.execute("SELECT data FROM records WHERE id=?", (descendant,)).fetchone()[0])
        for hit in sections.find_forbidden_keys(data):
            violations.append({"path": "%s.%s" % (descendant, hit["path"]), "field": hit["field"]})
    if violations:
        raise sections.SectionRuleViolation(violations)


def node_lifecycle(body, path=None):
    """archive / unarchive / delete / restore with a base Revision (one Revision each)."""
    body = _body(body)
    node_id = _node_id(body)
    operation = body.get("operation")
    if operation not in OPERATIONS:
        raise _fields_error([("operation", "必须是 %s 之一" % " / ".join(OPERATIONS))])
    revision = _base_revision(body)
    with _writer(path) as con:
        row = _row_or_404(con, node_id, allow_deleted=True)
        _check_revision(row, revision)
        state = {"archive": not row["archived_at"], "unarchive": bool(row["archived_at"]),
                 "delete": not row["deleted_at"], "restore": bool(row["deleted_at"])}
        if not state[operation]:
            raise NodeError("节点当前状态不允许该操作", code="invalid_state", details={"operation": operation})
        if operation == "delete":
            active = len(_Index(con).active_children(node_id))
            if active:
                raise NodeError("该节点仍有 %d 个未归档的子节点，请先归档或移动它们" % active,
                                code="has_children", details={"count": active})
        if operation == "restore" and row["parent_id"]:
            parent = con.execute("SELECT deleted_at FROM records WHERE id=?", (row["parent_id"],)).fetchone()
            if parent is None or parent["deleted_at"]:
                raise NodeError("请先恢复父节点", code="parent_deleted", details={"parentId": row["parent_id"]})
        try:
            store._lifecycle_tx(con, node_id, revision, operation, ACTOR, "shell:node-lifecycle",
                                blocking_children="active")
        except store.Conflict:
            raise RevisionConflict(row["revision"], _current_view(row)) from None
        return {"node": _dto(con, node_id, allow_deleted=True)}


def summary_set(body, path=None):
    """Set (or clear, with ``text == ""``) the Summary_Block; html is rendered server-side."""
    body = _body(body)
    node_id = _node_id(body)
    text = body.get("text")
    try:
        block = work_hub_html.render_summary(text)
    except work_hub_html.ContentError as exc:
        raise NodeError(str(exc), code=exc.code, details={"fields": [{"field": "text", "reason": str(exc)}],
                                                          **exc.details}) from None
    with _writer(path) as con:
        record = _editable(con, node_id, body)
        data = copy.deepcopy(record["data"])
        data["summaryBlock"] = block
        saved = _save(con, _payload_for(record, data=data), "shell:summary-set")
        return {"node": _dto(con, saved["id"])}


# --------------------------------------------------------------------------
# Phase 2: aggregation context shared by tasks / cockpit / reminders / search / tags
# --------------------------------------------------------------------------
PRIORITY_RANK = {name: rank for rank, name in enumerate(ext.PRIORITIES)}
COCKPIT_LIMIT = 20
COCKPIT_GROUPS = ("overdue", "today", "week", "reminders", "followUp", "recent")
RECENT_DAYS = 7
UPCOMING_HOURS = 24
SNOOZE_MINUTES = (10, 60, 1440)
SEARCH_LIMIT = 50
SEARCH_QUERY_MAX = 200
SEARCH_SNIPPET = 40


class _Context:
    """One pass over the database: visible nodes, side tables and task properties."""

    def __init__(self, con, now_minute):
        self.con = con
        self.now = now_minute
        self.index = _Index(con)
        self.top_map = _top_sections(con, self.index)
        self.section_map = _section_lookup(con)
        self.visible = {}                       # node id -> section id, in tree (DFS) order
        order = {s["id"]: s["sortOrder"] for s in sections.list_sections(con)}
        roots = [i for i in self.index.roots() if self.index.is_tree(self.index.rows[i])
                 and not self.index.rows[i]["archived_at"] and not self.index.rows[i]["deleted_at"]]
        roots.sort(key=lambda i: (order.get(self.top_map[i], 10 ** 9), self.index.rows[i]["created_at"], i))
        stack = [(r, self.top_map[r]) for r in reversed(roots)]
        while stack:
            node_id, section_id = stack.pop()
            if node_id in self.visible:
                continue
            self.visible[node_id] = section_id
            for child in reversed(self.index.active_children(node_id)):
                stack.append((child, section_id))
        self.ext = {r[0]: (r[1], r[2], r[3]) for r in con.execute(
            "SELECT record_id,remind_at,repeat_rule,handled_for FROM work_task_ext")}
        self.unconfirmed = _unconfirmed_counts(con)
        self.tags = {}
        for record_id, tag in con.execute("SELECT record_id,tag FROM work_tags ORDER BY tag"):
            self.tags.setdefault(record_id, []).append(tag)
        self.props = {}
        self.assignees = {}
        self.note_counts = {}
        for record_id, data in con.execute("SELECT id,data FROM records WHERE deleted_at IS NULL"):
            if '"priority"' in data or '"dueDate"' in data:
                parsed = _loads(data) or {}
                priority, due = parsed.get("priority"), parsed.get("dueDate")
                self.props[record_id] = (priority if isinstance(priority, str) else None,
                                         due if isinstance(due, str) and due else None)
            if '"assignee"' in data:
                assignee = (_loads(data) or {}).get('assignee')
                if isinstance(assignee, str) and assignee:
                    self.assignees[record_id] = assignee
            if '"noteEntries"' in data:
                entries = (_loads(data) or {}).get("noteEntries")
                if isinstance(entries, list) and entries:
                    self.note_counts[record_id] = sum(1 for e in entries if isinstance(e, dict))
        self.material_counts = {r[0]: r[1] for r in con.execute(
            """SELECT l.source_id,COUNT(*) FROM links l JOIN records r ON r.id=l.target_id
               WHERE l.relation='reference' AND r.kind='material' AND r.deleted_at IS NULL GROUP BY l.source_id""")}

    def task_ids(self):
        return [i for i in self.visible if self.index.rows[i]["kind"] in TASK_KINDS]

    def is_pending(self, node_id):
        remind_at, _, handled_for = self.ext.get(node_id, (None, None, None))
        return ext.pending(remind_at, handled_for, self.index.rows[node_id]["status"], self.now)

    def row(self, node_id):
        """TaskRow (design 4.16); also used for non-task nodes in Cockpit groups."""
        record = self.index.rows[node_id]
        priority, due = self.props.get(node_id, (None, None))
        remind_at, rule, handled_for = self.ext.get(node_id, (None, None, None))
        chain = self.index.chain(node_id)
        sub_tasks = [d for d in self.index.descendants(node_id) if self.index.rows[d]["kind"] in TASK_KINDS]
        open_children = sum(1 for d in sub_tasks if self.index.rows[d]["status"] != "Done")
        return {
            "id": node_id, "kind": record["kind"], "title": record["title"], "status": record["status"],
            "priority": priority, "dueDate": due, "assignee": self.assignees.get(node_id, ""), "remindAt": remind_at,
            "remindPending": ext.pending(remind_at, handled_for, record["status"], self.now),
            "repeat": _loads(rule) if rule else None, "tags": list(self.tags.get(node_id, [])),
            "parentId": record["parent_id"],
            "path": [{"id": i, "title": self.index.rows[i]["title"]} for i in chain[:-1]],
            "sectionId": self.visible.get(node_id), "revision": record["revision"],
            "openChildCount": open_children, "unconfirmed": self.unconfirmed.get(node_id, 0),
            "updatedAt": record["updated_at"],
            # additive card counts (UI parity): sub-tasks (all descendants), notes and linked materials
            "subtaskTotal": len(sub_tasks), "subtaskDone": len(sub_tasks) - open_children,
            "noteCount": self.note_counts.get(node_id, 0), "materialCount": self.material_counts.get(node_id, 0),
        }


def _bool_param(value, name):
    if value in (None, "", False, 0, "0", "false", "False"):
        return False
    if value in (True, 1, "1", "true", "True"):
        return True
    raise _fields_error([(name, "必须是 0 或 1")])


def _now_param(value):
    if value in (None, ""):
        return _local_minute()
    minute = ext.minute_now(value)
    if minute is None:
        raise _fields_error([("now", "必须是 YYYY-MM-DDTHH:MM")])
    return minute


def _today_param(value):
    if value in (None, ""):
        return _dt.date.today().isoformat()
    clean, reason = ext.check_due_date(value)
    if reason or not clean:
        raise _fields_error([("today", reason or "必填")])
    return clean


# --------------------------------------------------------------------------
# view=tasks
# --------------------------------------------------------------------------
def parse_task_filters(raw):
    """Normalize filter parameters (``status[]``/``status`` repeated or a list) or raise 400."""
    raw = raw or {}

    def many(name):
        values = []
        for key in (name, name + "[]"):
            value = raw.get(key)
            if value is None:
                continue
            if isinstance(value, str):
                value = [value]
            if not isinstance(value, (list, tuple)) or any(not isinstance(v, str) for v in value):
                raise _fields_error([(name, "必须是文本或文本列表")])
            values += [v for v in value if v != ""]
        return list(dict.fromkeys(values))

    problems = []
    status, priority = many("status"), many("priority")
    problems += [("status", "未知状态 %s" % s) for s in status if s not in store.STATES][:1]
    problems += [("priority", "未知优先级 %s" % p) for p in priority if p not in ext.PRIORITIES][:1]
    bounds = {}
    for key in ("dueFrom", "dueTo"):
        value = raw.get(key)
        if isinstance(value, (list, tuple)):
            value = value[0] if value else None
        clean, reason = ext.check_due_date(value)
        if reason:
            problems.append((key, reason))
        bounds[key] = clean or None
    if problems:
        raise _fields_error(problems)
    return {"status": status, "priority": priority, "tag": many("tag"), "section": many("section"),
            "dueFrom": bounds["dueFrom"], "dueTo": bounds["dueTo"]}


def task_matches(row, filters):
    """Same dimension = union, different dimensions = intersection (shared golden vectors)."""
    if filters.get("status") and row.get("status") not in filters["status"]:
        return False
    if filters.get("priority") and row.get("priority") not in filters["priority"]:
        return False
    if filters.get("tag") and not set(row.get("tags") or ()) & set(filters["tag"]):
        return False
    if filters.get("section") and row.get("sectionId") not in filters["section"]:
        return False
    due_from, due_to = filters.get("dueFrom"), filters.get("dueTo")
    if due_from or due_to:
        due = row.get("dueDate")
        if not due or (due_from and due < due_from) or (due_to and due > due_to):
            return False
    return True


def filter_task_rows(rows, filters):
    parsed = parse_task_filters(filters)
    return [row for row in rows if task_matches(row, parsed)]


def sort_task_rows(rows):
    """``dueDate`` ascending (none last), then ``updatedAt`` descending, then id."""
    ordered = sorted(rows, key=lambda r: r["id"])
    ordered.sort(key=lambda r: r["updatedAt"] or "", reverse=True)
    ordered.sort(key=lambda r: (r["dueDate"] is None, r["dueDate"] or ""))
    return ordered


def tasks_view(scope="all", id=None, direct=False, filters=None, path=None, now=None):  # noqa: A002
    """``{items: [TaskRow], total}`` for a node subtree or for every visible Task."""
    if scope not in ("all", "node"):
        raise _fields_error([("scope", "必须是 all 或 node")])
    direct = _bool_param(direct, "direct")
    parsed = parse_task_filters(filters)
    if scope == "node" and not (isinstance(id, str) and id):
        raise _fields_error([("id", "scope=node 时必填")])
    with _reader(path) as con:
        if scope == "node":
            _row_or_404(con, id)
        context = _Context(con, _now_param(now))
        if scope == "all":
            ids = context.task_ids()
        else:
            below = context.index.active_children(id) if direct else context.index.descendants(id)
            ids = [i for i in below if i in context.visible and context.index.rows[i]["kind"] in TASK_KINDS]
        rows = [context.row(i) for i in ids]
        items = sort_task_rows([r for r in rows if task_matches(r, parsed)])
        return {"items": items, "total": len(items)}


# --------------------------------------------------------------------------
# view=reminders / reminder-handle
# --------------------------------------------------------------------------
def reminders_view(now=None, path=None):
    """``{due, upcoming}``: pending reminders, and those falling in the next 24 hours."""
    current = _now_param(now)
    horizon = (_dt.datetime.strptime(current, "%Y-%m-%dT%H:%M")
               + _dt.timedelta(hours=UPCOMING_HOURS)).strftime("%Y-%m-%dT%H:%M")
    with _reader(path) as con:
        context = _Context(con, current)
        due, upcoming = [], []
        for node_id in context.task_ids():
            remind_at, _, handled_for = context.ext.get(node_id, (None, None, None))
            if not remind_at or handled_for == remind_at or context.index.rows[node_id]["status"] == "Done":
                continue
            if remind_at <= current:
                due.append(context.row(node_id))
            elif remind_at <= horizon:
                upcoming.append(context.row(node_id))
        key = lambda r: (r["remindAt"], r["id"])  # noqa: E731
        return {"due": sorted(due, key=key), "upcoming": sorted(upcoming, key=key)}


def reminder_handle(body, path=None):
    """Mark the current reminder handled (no Revision) or snooze it (one Revision)."""
    body = _body(body)
    node_id = _node_id(body)
    remind_at = body.get("remindAt")
    kind = body.get("kind")
    problems = []
    if not isinstance(remind_at, str) or ext.check_remind_at(remind_at)[0] is None:
        problems.append(("remindAt", "必须是 YYYY-MM-DDTHH:MM"))
    if kind not in ("handled", "snooze"):
        problems.append(("kind", "必须是 handled 或 snooze"))
    minutes = body.get("minutes")
    if kind == "snooze" and (type(minutes) is not int or minutes not in SNOOZE_MINUTES):
        problems.append(("minutes", "必须是 %s 之一" % " / ".join(str(m) for m in SNOOZE_MINUTES)))
    if problems:
        raise _fields_error(problems)
    clock = body.get("now")
    if clock is not None and ext.minute_now(clock) is None:
        raise _fields_error([("now", "必须是 YYYY-MM-DDTHH:MM")])
    with _writer(path) as con:
        row = _row_or_404(con, node_id)
        current = ext.get_ext(con, node_id)
        if current["remind_at"] != remind_at:
            raise NodeError("提醒已被修改，请刷新后再处理", code="reminder_changed", status=409,
                            details={"remindAt": current["remind_at"]})
        stamp = store._now()
        if kind == "handled":
            con.execute("UPDATE work_task_ext SET handled_for=?,handled_at=?,handled_action='handled' "
                        "WHERE record_id=?", (remind_at, stamp, node_id))
            return {"node": _dto(con, node_id)}
        base = _base_revision(body)
        _check_revision(row, base)
        moment = _dt.datetime.strptime(ext.minute_now(clock) or _local_minute(), "%Y-%m-%dT%H:%M")
        new_remind = (moment + _dt.timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M")
        before_ext = ext.snapshot(con, node_id)
        con.execute("UPDATE work_task_ext SET remind_at=?,handled_for=?,handled_at=?,handled_action='snooze' "
                    "WHERE record_id=?", (new_remind, remind_at, stamp, node_id))
        record = store._serialize(row)
        saved = _save(con, _payload_for(record), "shell:reminder-snooze",
                      extra={"ext": ext.snapshot(con, node_id, force=True),
                             "_change": {"type": "reminder-snooze", "minutes": minutes}},
                      before_extra={"ext": before_ext} if before_ext else None)
        return {"node": _dto(con, saved["id"])}


# --------------------------------------------------------------------------
# view=cockpit
# --------------------------------------------------------------------------
def _sorted_by_due(rows):
    ordered = sort_task_rows(rows)
    ordered.sort(key=lambda r: (r["dueDate"] is None, r["dueDate"] or "",
                                PRIORITY_RANK.get(r["priority"], len(PRIORITY_RANK))))
    return ordered


def is_overdue(row, today):
    return bool(row["dueDate"]) and row["dueDate"] < today and row["status"] != "Done"


def _open_task_rows(context):
    return [context.row(i) for i in context.task_ids() if context.index.rows[i]["status"] != "Done"]


def _group_overdue(context, today, now):
    return _sorted_by_due([r for r in _open_task_rows(context) if is_overdue(r, today)])


def _group_today(context, today, now):
    return _sorted_by_due([r for r in _open_task_rows(context) if r["dueDate"] == today])


def week_end(today):
    day = _dt.date.fromisoformat(today)
    return (day + _dt.timedelta(days=7 - day.isoweekday())).isoformat()


def _group_week(context, today, now):
    end = week_end(today)
    return _sorted_by_due([r for r in _open_task_rows(context) if r["dueDate"] and today < r["dueDate"] <= end])


def _group_reminders(context, today, now):
    rows = [context.row(i) for i in context.task_ids() if context.is_pending(i)]
    return sorted(rows, key=lambda r: (r["remindAt"], r["id"]))


def _group_followUp(context, today, now):  # noqa: N802 (name mirrors the group key)
    rows = [context.row(i) for i in context.visible if context.index.rows[i]["status"] in ("Blocked", "Waiting")]
    return sorted(sorted(rows, key=lambda r: r["id"]), key=lambda r: r["updatedAt"] or "", reverse=True)


def _group_recent(context, today, now):
    cutoff = _dt.datetime.strptime(now, "%Y-%m-%dT%H:%M").astimezone(_dt.timezone.utc) \
        - _dt.timedelta(days=RECENT_DAYS)
    latest = {}
    for record_id, stamp in context.con.execute(
            "SELECT record_id,MAX(occurred_at) FROM revisions WHERE occurred_at>=? GROUP BY record_id",
            (cutoff.strftime("%Y-%m-%dT%H:%M:%S+00:00"),)):
        if record_id in context.visible:
            latest[record_id] = stamp
    rows = []
    for record_id, stamp in latest.items():
        row = context.row(record_id)
        row["lastActivityAt"] = stamp
        rows.append(row)
    return sorted(sorted(rows, key=lambda r: r["id"]), key=lambda r: r["lastActivityAt"], reverse=True)


def cockpit_view(today=None, now=None, group=None, path=None):
    """Each group is built independently: ``{ok,total,items}`` or ``{ok:false,error}``."""
    if group not in (None, ""):
        if group not in COCKPIT_GROUPS:
            raise _fields_error([("group", "必须是 %s 之一" % " / ".join(COCKPIT_GROUPS))])
    today, current = _today_param(today), _now_param(now)
    wanted = [group] if group else list(COCKPIT_GROUPS)
    with _reader(path) as con:
        context = _Context(con, current)
        result = {"clock": {"today": today, "now": current}}
        module = globals()
        for name in wanted:
            try:
                rows = module["_group_" + name](context, today, current)
                result[name] = {"ok": True, "total": len(rows), "items": rows[:COCKPIT_LIMIT]}
            except Exception as exc:  # noqa: BLE001 - one failing group must not hide the others
                result[name] = {"ok": False, "error": "该分组加载失败: %s" % exc}
        return result


# --------------------------------------------------------------------------
# view=tags / tag-nodes
# --------------------------------------------------------------------------
def tags_view(path=None):
    """``[{tag, count}]`` over non-deleted nodes, most used first."""
    with _reader(path) as con:
        rows = con.execute(
            """SELECT t.tag,COUNT(*) FROM work_tags t JOIN records r ON r.id=t.record_id
               WHERE r.deleted_at IS NULL GROUP BY t.tag""").fetchall()
        return [{"tag": tag, "count": count} for tag, count in sorted(rows, key=lambda r: (-r[1], r[0]))]


def tag_nodes_view(tag, path=None):
    """Non-deleted nodes carrying ``tag`` with their Section; ``[]`` when none."""
    if not isinstance(tag, str) or not tag:
        raise _fields_error([("tag", "必填")])
    with _reader(path) as con:
        index = _Index(con)
        top_map = _top_sections(con, index)
        section_map = _section_lookup(con)
        ids = [r[0] for r in con.execute(
            """SELECT r.id FROM work_tags t JOIN records r ON r.id=t.record_id
               WHERE t.tag=? AND r.deleted_at IS NULL ORDER BY r.updated_at DESC,r.id""", (tag,))]
        items = []
        for node_id in ids:
            section_id = top_map.get(index.top(node_id))
            section = section_map.get(section_id) or sections.UNCLASSIFIED
            items.append({"id": node_id, "title": index.rows[node_id]["title"],
                          "kind": index.rows[node_id]["kind"], "sectionId": section["id"],
                          "sectionTitle": section["title"]})
        return items


# --------------------------------------------------------------------------
# link-add / link-remove (typed links; no Revision)
# --------------------------------------------------------------------------
def _link_args(body):
    body = _body(body)
    source, target = body.get("sourceId"), body.get("targetId")
    problems = [(key, "必填，且必须是字符串") for key, value in (("sourceId", source), ("targetId", target))
                if not isinstance(value, str) or not value]
    relation, reason = ext.check_relation(body.get("relation"))
    if reason:
        problems.append(("relation", reason))
    if problems:
        raise _fields_error(problems)
    return source, target, relation


def link_add(body, path=None):
    source, target, relation = _link_args(body)
    if source == target:
        raise NodeError("不能关联到自身", code="link_self",
                        details={"fields": [{"field": "targetId", "reason": "不能关联到自身"}]})
    with _writer(path) as con:
        for node_id in (source, target):
            row = con.execute("SELECT deleted_at FROM records WHERE id=?", (node_id,)).fetchone()
            if row is None or row["deleted_at"]:
                raise NodeError("关联对象不存在或已删除: %s" % node_id, code="link_target_deleted", status=404,
                                details={"value": node_id})
        if con.execute("SELECT 1 FROM links WHERE source_id=? AND target_id=? AND relation=?",
                       (source, target, relation)).fetchone():
            raise NodeError("该关联已存在", code="link_exists", status=409)
        con.execute("INSERT INTO links(source_id,target_id,relation) VALUES(?,?,?)", (source, target, relation))
        return {"link": {"sourceId": source, "targetId": target, "relation": relation}}


def link_remove(body, path=None):
    source, target, relation = _link_args(body)
    with _writer(path) as con:
        removed = con.execute("DELETE FROM links WHERE source_id=? AND target_id=? AND relation=?",
                              (source, target, relation)).rowcount
        if not removed:
            raise NodeError("关联不存在", code="link_not_found", status=404)
        return {"link": {"sourceId": source, "targetId": target, "relation": relation}}


# --------------------------------------------------------------------------
# view=search
# --------------------------------------------------------------------------
class _TextExtractor(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def handle_starttag(self, tag, attrs):
        self.parts.append(" ")


_NOTE_TEXT_CACHE = {}
_NOTE_CACHE_MAX = 20000


def _note_text(node_id, revision, raw):
    """Plain text of a node's Note entries, cached by ``(id, revision, content hash)``."""
    key = (node_id, revision, hash(raw))
    cached = _NOTE_TEXT_CACHE.get(key)
    if cached is not None:
        return cached
    data = _loads(raw) or {}
    entries = data.get("noteEntries")
    texts = []
    for entry in entries if isinstance(entries, list) else []:
        if isinstance(entry, dict) and isinstance(entry.get("html"), str):
            parser = _TextExtractor()
            try:
                parser.feed(entry["html"])
                parser.close()
            except Exception:  # noqa: BLE001 - malformed stored HTML must not break search
                continue
            texts.append("".join(parser.parts))
    text = "\n".join(texts)
    if len(_NOTE_TEXT_CACHE) >= _NOTE_CACHE_MAX:
        _NOTE_TEXT_CACHE.clear()
    _NOTE_TEXT_CACHE[key] = text
    return text


def _snippet(text, needle_key):
    """~80 characters around the first case-insensitive occurrence of the query."""
    folded = _key(text)
    position = folded.find(needle_key)
    if position < 0 or len(folded) != len(text):      # casefold changed lengths: fall back to the start
        position = max(0, position) if position >= 0 else 0
    start = max(0, position - SEARCH_SNIPPET)
    cut = text[start:position + len(needle_key) + SEARCH_SNIPPET].replace("\n", " ").strip()
    return ("…" if start else "") + cut


def search_view(q, limit=None, section=None, path=None, max_limit=SEARCH_LIMIT):
    """Case-insensitive substring search over title / tags / summary / Note text (design 4.15)."""
    if not isinstance(q, str) or not q.strip() or len(q) > SEARCH_QUERY_MAX:
        raise _fields_error([("q", "必须是 1 到 %d 个字符" % SEARCH_QUERY_MAX)])
    limit = _int_param(limit, "limit", max_limit, 1, max_limit)
    needle = _key(q.strip())
    with _reader(path) as con:
        context = _Context(con, _local_minute())
        raw = {r[0]: r[1] for r in con.execute("SELECT id,data FROM records WHERE deleted_at IS NULL")}
        hits = []
        for node_id, section_id in context.visible.items():
            if section and section_id != section:
                continue
            record = context.index.rows[node_id]
            data_text = raw.get(node_id, "{}")
            matched, snippets = [], {}
            if needle in _key(record["title"]):
                matched.append("title")
                snippets["title"] = record["title"]
            for tag in context.tags.get(node_id, ()):
                if needle in _key(tag):
                    matched.append("tags")
                    snippets["tags"] = tag
                    break
            if '"summaryBlock"' in data_text:
                summary = _summary_of(_loads(data_text) or {})["text"]
                if summary and needle in _key(summary):
                    matched.append("summary")
                    snippets["summary"] = _snippet(summary, needle)
            if '"noteEntries"' in data_text:
                notes = _note_text(node_id, record["revision"], data_text)
                if notes and needle in _key(notes):
                    matched.append("notes")
                    snippets["notes"] = _snippet(notes, needle)
            if matched:
                hits.append((node_id, matched, snippets[matched[0]]))
        hits.sort(key=lambda h: h[0])
        hits.sort(key=lambda h: context.index.rows[h[0]]["updated_at"], reverse=True)
        hits.sort(key=lambda h: ("title", "tags", "summary", "notes").index(h[1][0]))
        results = []
        for node_id, matched, snippet in hits[:limit]:
            record = context.index.rows[node_id]
            section_id = context.visible[node_id]
            section_info = context.section_map.get(section_id) or sections.UNCLASSIFIED
            segments = _node_path_segments(context.index, context.section_map, context.top_map, node_id)
            results.append({"id": node_id, "title": record["title"], "kind": record["kind"],
                            "sectionId": section_id, "sectionTitle": section_info["title"],
                            "nodePath": format_node_path(segments), "matchedIn": matched, "snippet": snippet})
        return results


# --------------------------------------------------------------------------
# Phase 3: unconfirmed Agent writes (read helpers; the writers live in work_hub_agent)
# --------------------------------------------------------------------------
def _unconfirmed_counts(con):
    """``{record_id: n}`` of Agent writes still in the ``unconfirmed`` state."""
    return {r[0]: r[1] for r in con.execute(
        "SELECT record_id,COUNT(*) FROM work_agent_writes WHERE state='unconfirmed' GROUP BY record_id")}


def _unconfirmed_of(con, node_id):
    return [{"writeId": r["write_id"], "op": r["op"], "ref": r["ref"], "actor": r["actor"],
             "createdAt": r["created_at"]}
            for r in con.execute(
                "SELECT write_id,op,ref,actor,created_at FROM work_agent_writes "
                "WHERE record_id=? AND state='unconfirmed' ORDER BY created_at,write_id", (node_id,))]


# --------------------------------------------------------------------------
# notes-save (Req 19)
# --------------------------------------------------------------------------
def validate_note_entries(entries):
    """Strict validation of a whole Notes list; returns clean entries or raises 400 (nothing written)."""
    if not isinstance(entries, list):
        raise _fields_error([("entries", "必须是列表")])
    if len(entries) > work_hub_notes.V2_MAX_NOTES:
        raise NodeError("最多 %d 条 Note" % work_hub_notes.V2_MAX_NOTES, code="too_many_notes",
                        details={"fields": [{"field": "entries", "reason": "最多 %d 条" % work_hub_notes.V2_MAX_NOTES}]})
    clean, seen, total = [], set(), 0
    for index, entry in enumerate(entries):
        name = "entries[%d]" % index
        if not isinstance(entry, dict) or set(entry) != {"id", "title", "html"}:
            raise _fields_error([(name, "必须恰好包含 id、title、html")])
        note_id, title, body = entry["id"], entry["title"], entry["html"]
        if not isinstance(note_id, str) or not work_hub_notes.NOTE_ID.fullmatch(note_id):
            raise _fields_error([(name + ".id", "Note ID 格式无效")])
        if note_id in seen:
            raise _fields_error([(name + ".id", "Note ID 重复")])
        seen.add(note_id)
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= work_hub_notes.V2_MAX_TITLE:
            raise _fields_error([(name + ".title", "必须是 1 到 %d 个字符" % work_hub_notes.V2_MAX_TITLE)])
        if not isinstance(body, str):
            raise _fields_error([(name + ".html", "必须是文本")])
        size = len(body.encode("utf-8"))
        if size > work_hub_notes.V2_MAX_HTML:
            raise NodeError("单条 Note 不能超过 1 MiB", code="note_too_large",
                            details={"fields": [{"field": name + ".html", "reason": "超过 1 MiB"}]})
        total += size
        try:
            work_hub_html.validate_strict(body)
        except ValueError as exc:
            raise NodeError("Note 含不允许的内容: %s" % exc, code="note_html_invalid",
                            details={"fields": [{"field": name + ".html", "reason": str(exc)}]}) from None
        clean.append({"id": note_id, "title": title.strip(), "html": body})
    if total > work_hub_notes.MAX_TOTAL_HTML:
        raise NodeError("Note 总量不能超过 6 MiB", code="notes_too_large",
                        details={"fields": [{"field": "entries", "reason": "总量超过 6 MiB"}]})
    return clean


def notes_save(body, path=None):
    """Replace all Notes of a node in one Revision. Rejects the whole save on any bad entry."""
    body = _body(body)
    node_id = _node_id(body)
    entries = validate_note_entries(body.get("entries"))
    with _writer(path) as con:
        if con.execute("SELECT value FROM work_meta WHERE key='notebook_v3_ready'").fetchone():
            raise NodeError('Legacy notes-save is disabled after Notes V3 cutover', code='legacy_notes_readonly',status=409)
        record = _editable(con, node_id, body)
        if record["kind"] not in sections.TREE_KINDS:
            raise NodeError("该类型的节点不支持 Note", code="invalid_request",
                            details={"fields": [{"field": "id", "reason": "不是树节点"}]})
        data = copy.deepcopy(record["data"])
        data["noteEntries"] = entries
        saved = _save(con, _payload_for(record, data=data), "shell:notes-save")
        return {"node": _dto(con, saved["id"])}


# --------------------------------------------------------------------------
# Summary history and rollback (Req 21)
# --------------------------------------------------------------------------
def _summary_history(con, node_id):
    """Revisions that changed ``summaryBlock.text``, oldest first."""
    found = []
    for r in con.execute("SELECT revision,actor,source,before_json,after_json,occurred_at FROM revisions "
                         "WHERE record_id=? ORDER BY revision", (node_id,)):
        before, after = _loads(r["before_json"]) or {}, _loads(r["after_json"]) or {}
        old = _summary_of(before.get("data") if isinstance(before.get("data"), dict) else {})["text"]
        new = _summary_of(after.get("data") if isinstance(after.get("data"), dict) else {})["text"]
        if old != new:
            found.append({"revision": r["revision"], "actor": r["actor"], "source": r["source"],
                          "occurredAt": r["occurred_at"], "text": new})
    return found


def summary_history_view(id, path=None):  # noqa: A002
    """Summary edits, newest first, with ``isCurrent`` / ``rollbackable`` flags."""
    with _reader(path) as con:
        _row_or_404(con, id)
        history = list(reversed(_summary_history(con, id)))
        return [{**item, "isCurrent": index == 0, "rollbackable": index != 0}
                for index, item in enumerate(history)]


def summary_rollback(body, path=None):
    """Re-apply the text of an earlier Summary revision as a NEW revision (history is never rewritten)."""
    body = _body(body)
    node_id = _node_id(body)
    target = body.get("targetRevision")
    if type(target) is not int or target < 1:
        raise _fields_error([("targetRevision", "必须是正整数")])
    with _writer(path) as con:
        record = _editable(con, node_id, body)
        match = next((h for h in _summary_history(con, node_id) if h["revision"] == target), None)
        if match is None:
            raise NodeError("目标 Revision 不属于该节点的 Summary 历史", code="rollback_target_invalid",
                            details={"fields": [{"field": "targetRevision", "reason": "不在 Summary 历史中"}]})
        data = copy.deepcopy(record["data"])
        data["summaryBlock"] = work_hub_html.render_summary(match["text"])
        saved = _save(con, _payload_for(record, data=data), "summary-rollback:%d" % target)
        return {"node": _dto(con, saved["id"])}


# --------------------------------------------------------------------------
# Materials (Req 20)
# --------------------------------------------------------------------------
MATERIAL_TYPES = ("file", "link", "report")
MAX_URL = 2000


def validate_material(body):
    """Validate a material spec: ``{type,title,url?,fileId?,format?}``; raises 400 field errors."""
    kind = body.get("type")
    problems = []
    if kind not in MATERIAL_TYPES:
        raise _fields_error([("type", "必须是 %s 之一" % " / ".join(MATERIAL_TYPES))])
    title = body.get("title")
    if title in (None, "") and kind == "file":
        title = ""
    else:
        title, reason = _validate_title(title)
        if reason:
            problems.append(("title", reason))
    spec = {"type": kind, "title": title}
    if kind == "link":
        url = body.get("url")
        if not isinstance(url, str) or not url.strip() or len(url) > MAX_URL:
            problems.append(("url", "必须是 1 到 %d 个字符的链接" % MAX_URL))
        elif not re.fullmatch(r"https?://[^\s<>\x00-\x1f]+", url.strip(), re.I):
            raise NodeError("链接协议只支持 http / https", code="link_scheme_unsupported",
                            details={"fields": [{"field": "url", "reason": "仅支持 http / https"}]})
        else:
            spec["url"] = url.strip()
    else:
        file_id = body.get("fileId")
        if not isinstance(file_id, str) or not FILE_ID.match(file_id):
            problems.append(("fileId", "必须是 File Hub 稳定文件 ID"))
        else:
            spec["fileId"] = file_id
        if kind == "report":
            if body.get("format") not in ("md", "html"):
                problems.append(("format", "必须是 md 或 html"))
            else:
                spec["format"] = body["format"]
    if problems:
        raise _fields_error(problems)
    return spec


def add_material_tx(con, record, spec, *, actor, source, origin=None):
    """Create a material record, its ``reference`` link and one node Revision (caller owns the tx).

    Returns ``(material_id, saved_node)``. A ``file`` material without a title takes the File Hub name.
    """
    title = spec["title"]
    data = {"materialType": spec["type"]}
    if spec["type"] == "link":
        data["url"] = spec["url"]
    else:
        data["fileId"] = spec["fileId"]
        known, info = _file_lookup(spec["fileId"])
        if known and info is None:
            raise NodeError("File Hub 中找不到该文件: %s" % spec["fileId"], code="file_not_found", status=404,
                            details={"value": spec["fileId"]})
        if not title:
            title = (info or {}).get("name") or spec["fileId"]
        if spec["type"] == "report":
            data["format"] = spec["format"]
            data["origin"] = origin or "user"
    material_id = "mat-" + uuid.uuid4().hex
    _save(con, {"id": material_id, "kind": "material", "title": title, "status": "Planned",
                "parent_id": None, "data": data, "revision": 0}, source, actor=actor)
    con.execute("INSERT INTO links(source_id,target_id,relation) VALUES(?,?,'reference')",
                (record["id"], material_id))
    saved = _save(con, _payload_for(record), source, actor=actor,
                  extra={"_change": {"type": "material-add", "materialId": material_id}})
    return material_id, saved


def material_add(body, path=None):
    body = _body(body)
    node_id = _node_id(body)
    _base_revision(body)
    spec = validate_material(body)
    with _writer(path) as con:
        record = _editable(con, node_id, body)
        if record["kind"] not in sections.TREE_KINDS:
            raise NodeError("该类型的节点不支持资料", code="invalid_request",
                            details={"fields": [{"field": "id", "reason": "不是树节点"}]})
        material_id, saved = add_material_tx(con, record, spec, actor=ACTOR, source="shell:material-add")
        return {"node": _dto(con, saved["id"]), "material": {"id": material_id}}


def remove_material_link_tx(con, record, material_id, *, actor, source, change=None):
    """Unlink ``material_id`` from the node (one Revision); soft-delete the record if unreferenced.

    The File Hub file is never touched (Req 20.9). Returns the saved node.
    """
    removed = con.execute("DELETE FROM links WHERE source_id=? AND target_id=? AND relation='reference'",
                          (record["id"], material_id)).rowcount
    if not removed:
        raise NodeError("该节点没有这个资料", code="material_not_found", status=404,
                        details={"value": material_id})
    saved = _save(con, _payload_for(record), source, actor=actor,
                  extra={"_change": change or {"type": "material-remove", "materialId": material_id}})
    others = con.execute("SELECT COUNT(*) FROM links WHERE target_id=? AND relation='reference'",
                         (material_id,)).fetchone()[0]
    material = con.execute("SELECT revision,deleted_at FROM records WHERE id=?", (material_id,)).fetchone()
    if not others and material is not None and not material["deleted_at"]:
        store._lifecycle_tx(con, material_id, material["revision"], "delete", actor, source,
                            blocking_children="active", extra={"_change": change} if change else None)
    return saved


def material_remove(body, path=None):
    body = _body(body)
    node_id = _node_id(body)
    material_id = _node_id(body, "materialId")
    _base_revision(body)
    with _writer(path) as con:
        record = _editable(con, node_id, body)
        saved = remove_material_link_tx(con, record, material_id, actor=ACTOR, source="shell:material-remove")
        return {"node": _dto(con, saved["id"])}


MATERIAL_PURPOSES = ("reference", "plan", "deliverable", "evidence", "related")


def _material_meta_schema(con):
    con.execute("""CREATE TABLE IF NOT EXISTS material_assoc_meta(
        node_id TEXT NOT NULL,
        ref_kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        purpose TEXT,
        description TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(node_id, ref_kind, ref_id)
    )""")


def material_meta(body, path=None):
    """Modify only one Work Node's association metadata; never file bytes."""
    body = _body(body)
    node_id = _node_id(body)
    ref_kind = body.get("refKind")
    ref_id = body.get("refId")
    purpose = body.get("purpose", "reference")
    description = body.get("description", "")
    if ref_kind not in ("material", "hub") or not isinstance(ref_id, str) or not ref_id:
        raise _fields_error([("refId", "有效的 Material 或 File Hub ID 必填")])
    if purpose not in MATERIAL_PURPOSES:
        raise _fields_error([("purpose", "Unsupported purpose")])
    if not isinstance(description, str) or len(description) > 4000:
        raise _fields_error([("description", "Description must be at most 4000 characters")])
    with _writer(path) as con:
        node = _editable(con, node_id, body)
        if node["kind"] not in sections.TREE_KINDS:
            raise NodeError("Materials are only supported on Work tree nodes")
        if ref_kind == "material":
            valid = con.execute("""SELECT 1 FROM links l JOIN records m ON m.id=l.target_id
                WHERE l.source_id=? AND l.target_id=? AND m.kind='material'
                  AND m.deleted_at IS NULL LIMIT 1""", (node_id, ref_id)).fetchone()
            if not valid:
                raise NodeError("Material is not directly associated with this node", code="material_not_found", status=404)
        else:
            hub = _file_hub()
            if hub is None:
                raise NodeError("File Hub unavailable", code="file_hub_unavailable", status=503)
            valid = any(row["id"] == ref_id for row in hub.linked_context(node["kind"], node_id))
            if not valid:
                raise NodeError("File is not directly associated with this node", code="material_not_found", status=404)
        _material_meta_schema(con)
        con.execute("""INSERT INTO material_assoc_meta(node_id,ref_kind,ref_id,purpose,description,updated_at)
            VALUES(?,?,?,?,?,?) ON CONFLICT(node_id,ref_kind,ref_id) DO UPDATE SET
            purpose=excluded.purpose,description=excluded.description,updated_at=excluded.updated_at""",
            (node_id, ref_kind, ref_id, purpose, description, store._now()))
        saved = _save(con, _payload_for(node), "shell:material-meta", actor=ACTOR,
                      extra={"_change": {"type": "material-meta", "refKind": ref_kind, "refId": ref_id}})
        return {"node": _dto(con, saved["id"])}


def materials_v3_view(id, path=None, *, q="", limit=100, offset=0, format_filter="", source="", purpose="", tag_filter="", sort_by="created"):  # noqa: A002
    """Complete server-filtered Materials pages without legacy 200-record truncation."""
    limit = _int_param(limit, "limit", 100, 1, 200)
    offset = _int_param(offset, "offset", 0, 0, 1000000)
    if not isinstance(q, str) or len(q) > 250:
        raise _fields_error([("q", "Search term too long")])
    data = materials_view(id, path=path, max_results=None)
    with _reader(path) as con:
        exists = con.execute("""SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_assoc_meta'""").fetchone()
        metas = {}
        if exists:
            for row in con.execute("SELECT * FROM material_assoc_meta"):
                metas[(row["node_id"], row["ref_kind"], row["ref_id"])] = dict(row)
    entries = []
    groups = (("items", "material"), ("fileHubRefs", "hub"),
              ("inherited", "material"), ("inheritedFileHubRefs", "hub"))
    for key, ref_kind in groups:
        for item in data.get(key, []):
            ref_id = item.get("id") if ref_kind == "material" else item.get("fileId")
            source_id = item.get("sourceNodeId") or id
            metadata = metas.get((source_id, ref_kind, ref_id))
            enriched = dict(item)
            if metadata:
                enriched["purpose"] = metadata["purpose"] or item.get("purpose", "reference")
                enriched["description"] = metadata["description"]
            elif ref_kind == "hub":
                enriched["purpose"] = item.get("relation", "reference")
            enriched["refKind"] = ref_kind
            entries.append((key, enriched))
    # Tags come from the canonical File Hub, not node associations.
    ids = {item.get("fileId") for _, item in entries if item.get("fileId")}
    tag_map = {}
    revision_map = {}
    if ids:
        hub = _file_hub()
        if hub is not None:
            with contextlib.closing(hub._db()) as hub_db:
                for fid in ids:
                    tag_map[fid] = [r[0] for r in hub_db.execute("SELECT tag FROM tags WHERE file_id=? ORDER BY tag", (fid,))]
                    file_row = hub_db.execute("SELECT revision,updated FROM files WHERE id=?", (fid,)).fetchone()
                    if file_row:
                        revision_map[fid] = (file_row["revision"], file_row["updated"])
    rows = []
    seen_file_ids = set()
    direct_level = data["lineage"][-1]["level"] if data.get("lineage") else 1
    for key, item in entries:
        if key in ("items", "fileHubRefs"):
            item["sourceLevel"] = item.get("sourceLevel") or direct_level
        fid = item.get("fileId")
        item["tags"] = tag_map.get(fid, [])
        if fid in revision_map:
            item["fileRevision"], item["fileUpdatedAt"] = revision_map[fid]
        title = str(item.get("displayName") or item.get("name") or item.get("title") or "")
        if q and q.casefold() not in (title + " " + str(item.get("description", "")) + " " +
                    " ".join(item["tags"]) + " " + str(item.get("sourceTitle", ""))).casefold():
            continue
        if format_filter and (title.rsplit(".", 1)[-1].casefold() if "." in title else "link") != format_filter.casefold():
            continue
        level = item.get("sourceLevel")
        if source in ("direct", "inherited") and (key in ("items", "fileHubRefs")) != (source == "direct"):
            continue
        if source in ("1", "2", "3") and str(level) != source:
            continue
        if purpose and item.get("purpose") != purpose:
            continue
        if tag_filter and tag_filter.casefold() not in [t.casefold() for t in item["tags"]]:
            continue
        canonical_id = item.get("fileId")
        if canonical_id and canonical_id in seen_file_ids:
            continue
        if canonical_id:
            seen_file_ids.add(canonical_id)
        rows.append((key, item))
    def timestamp(entry):
        value = entry[1].get("createdAt")
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                return _dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            except ValueError:
                return 0.0
        return 0.0
    if sort_by == 'name':
        rows.sort(key=lambda x: str(x[1].get('displayName') or x[1].get('name') or x[1].get('title') or '').casefold())
    elif sort_by == 'updated':
        rows.sort(key=lambda x: (x[1].get('fileUpdatedAt') or 0, timestamp(x)), reverse=True)
    else:
        rows.sort(key=lambda entry: (timestamp(entry), str(entry[1].get('id') or entry[1].get('fileId'))), reverse=True)
    total = len(rows)
    result = {key: [] for key, _ in groups}
    for key, item in rows[offset:offset + limit]:
        result[key].append(item)
    result.update({"lineage": data.get("lineage", []),
                   "total": total, "offset": offset, "limit": limit,
                   "hasMore": offset + limit < total})
    return result


MAX_FILE_REF_IDS = 50


def file_refs_view(ids, path=None):
    """``{<fileId>: [{nodeId, title}]}``: nodes referencing each File Hub file (materials + direct links)."""
    if isinstance(ids, str):
        ids = [part for part in ids.split(",") if part]
    if not isinstance(ids, list) or not ids or len(ids) > MAX_FILE_REF_IDS \
            or any(not isinstance(i, str) or not FILE_ID.match(i) for i in ids):
        raise _fields_error([("ids", "必须是 1 到 %d 个 File Hub 文件 ID（逗号分隔）" % MAX_FILE_REF_IDS)])
    wanted = list(dict.fromkeys(ids))
    result = {file_id: [] for file_id in wanted}
    with _reader(path) as con:
        seen = set()

        def add(file_id, node_id):
            row = con.execute("SELECT title,kind FROM records WHERE id=? AND deleted_at IS NULL",
                              (node_id,)).fetchone()
            if row is not None and row["kind"] in sections.TREE_KINDS and (file_id, node_id) not in seen:
                seen.add((file_id, node_id))
                result[file_id].append({"nodeId": node_id, "title": row["title"]})

        for r in con.execute("""SELECT m.data,l.source_id FROM records m JOIN links l
                                ON l.target_id=m.id AND l.relation='reference'
                                WHERE m.kind='material' AND m.deleted_at IS NULL AND m.data LIKE '%file_%'
                                ORDER BY l.source_id"""):
            file_id = (_loads(r["data"]) or {}).get("fileId")
            if file_id in result:
                add(file_id, r["source_id"])
        hub = _file_hub()
        if hub is not None:
            with contextlib.closing(hub._db()) as hub_con:
                for file_id in wanted:
                    for row in hub_con.execute(
                            "SELECT target_type,target_id FROM links WHERE file_id=? AND relation!='note-image'",
                            (file_id,)):
                        add(file_id, row["target_id"])
    return result
