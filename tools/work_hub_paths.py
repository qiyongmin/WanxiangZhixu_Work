"""Node_Path (design 4.14): grammar, formatting, resolution and request locators.

``parse`` / ``format`` are pure. ``resolve`` and ``locate`` read through an open
SQLite connection (``sqlite3.Row`` rows); nothing here writes.

Grammar: segments are separated by an unescaped ``/``; the only escapes are
``\\/`` (a slash) and ``\\\\`` (a backslash), any other backslash sequence is
malformed. 1-5 segments (Section title + at most 4 levels), each 1-300
characters, the whole string at most 2048 characters.
"""
from __future__ import annotations

import re
import unicodedata

import work_hub_sections as sections

MAX_LEN = 2048
MAX_SEGMENTS = 5
MAX_SEGMENT = 300
MAX_CANDIDATES = 50
_ID = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")


class PathError(ValueError):
    """Malformed Node_Path. ``category`` is ``empty`` / ``too_long`` / ``invalid``."""

    def __init__(self, category, position):
        super().__init__("Node_Path 无效（%s，位置 %d）" % (category, position))
        self.category = category
        self.position = position


class LocatorError(ValueError):
    """Locator failure with its HTTP status and machine code (raised before any write)."""

    def __init__(self, status, code, message, details=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.details = details or {}

    def payload(self):
        body = {"ok": False, "error": str(self), "code": self.code}
        if self.details:
            body["details"] = self.details
        return body


def parse(text):
    """Split an escaped Node_Path into 1-5 segments or raise ``PathError`` (no partial result)."""
    if not isinstance(text, str) or text == "":
        raise PathError("empty", 0)
    if len(text) > MAX_LEN:
        raise PathError("too_long", MAX_LEN)
    segments, starts, current, start, i = [], [], [], 0, 0
    while i < len(text):
        char = text[i]
        if char == "\\":
            if i + 1 >= len(text) or text[i + 1] not in "/\\":
                raise PathError("invalid", i)
            current.append(text[i + 1])
            i += 2
            continue
        if char == "/":
            segments.append("".join(current))
            starts.append(start)
            current, start = [], i + 1
        else:
            current.append(char)
        i += 1
    segments.append("".join(current))
    starts.append(start)
    for segment, begin in zip(segments, starts):
        if not segment:
            raise PathError("empty", begin)
        if len(segment) > MAX_SEGMENT:
            raise PathError("too_long", begin)
    if len(segments) > MAX_SEGMENTS:
        raise PathError("invalid", starts[MAX_SEGMENTS])
    return segments


def format(segments):  # noqa: A001 (mirrors the design's API name)
    """Join segments with ``/`` escaping ``\\`` and ``/`` inside them."""
    return "/".join(s.replace("\\", "\\\\").replace("/", "\\/") for s in segments)


def key(text):
    return unicodedata.normalize("NFC", text).casefold()


# --------------------------------------------------------------------------
# Database resolution
# --------------------------------------------------------------------------
def _children(con, parent_id):
    return con.execute(
        "SELECT id,kind,title,archived_at FROM records WHERE parent_id=? AND deleted_at IS NULL "
        "ORDER BY created_at,id", (parent_id,)).fetchall()


def resolve(con, segments):
    """Nodes addressed by ``segments``: ``[{id, archived}]`` sorted by id.

    The first segment is matched with the Section titles (``casefold(NFC)``), the
    following ones with the titles of the children. Deleted nodes are never
    addressable; archived ones are, and are flagged. A bare Section title
    addresses no node.
    """
    if not segments or len(segments) < 2:
        return []
    wanted_sections = {s["id"] for s in sections.list_sections(con)
                       if key(s["title"]) == key(segments[0])}
    if key(sections.UNCLASSIFIED["title"]) == key(segments[0]):
        wanted_sections.add(sections.UNCLASSIFIED_ID)
    if not wanted_sections:
        return []
    rows = {r["id"]: r for r in con.execute(
        "SELECT id,kind,parent_id,title,archived_at FROM records WHERE deleted_at IS NULL")}
    wanted = key(segments[1])
    frontier = []
    for row in rows.values():
        if (row["kind"] in sections.TREE_KINDS and (row["parent_id"] is None or row["parent_id"] not in rows)
                and key(row["title"]) == wanted
                and sections.section_of_top(con, row["id"], row["kind"]) in wanted_sections):
            frontier.append(row)
    for segment in segments[2:]:
        wanted = key(segment)
        frontier = [c for n in frontier for c in _children(con, n["id"])
                    if c["kind"] in sections.TREE_KINDS and key(c["title"]) == wanted]
    found = {r["id"]: r for r in frontier}
    return [{"id": i, "archived": bool(found[i]["archived_at"])} for i in sorted(found)]


def node_path_of(con, node_id):
    """Escaped Node_Path of an existing node (Section title + ancestor titles + own title)."""
    chain, seen, current = [], set(), node_id
    while current is not None and current not in seen:
        seen.add(current)
        row = con.execute("SELECT id,title,parent_id FROM records WHERE id=?", (current,)).fetchone()
        if row is None:
            break
        chain.append(row["title"])
        current = row["parent_id"]
    chain.reverse()
    section = sections.get_section(con, sections.effective_section(con, node_id) or sections.UNCLASSIFIED_ID)
    return format([(section or sections.UNCLASSIFIED)["title"]] + chain)


def _exists(con, node_id):
    return con.execute("SELECT 1 FROM records WHERE id=? AND deleted_at IS NULL", (node_id,)).fetchone() is not None


def _candidates(con, matches):
    return [{"id": m["id"], "nodePath": node_path_of(con, m["id"]), "archived": m["archived"]}
            for m in matches[:MAX_CANDIDATES]]


def _not_found(value):
    return LocatorError(404, "node_not_found", "节点不存在: %s" % (value,), {"value": value})


def _by_path(con, text, id_hint=None):
    try:
        segments = parse(text)
    except PathError as exc:
        raise LocatorError(400, "invalid_path", str(exc),
                           {"category": exc.category, "position": exc.position}) from None
    matches = resolve(con, segments)
    if not matches:
        raise _not_found(text)
    if len(matches) > 1:
        if id_hint is not None and any(m["id"] == id_hint for m in matches):
            return id_hint
        raise LocatorError(409, "ambiguous_path", "路径匹配多个节点",
                           {"candidates": _candidates(con, matches)})
    return matches[0]["id"]


def locate(con, params):
    """Resolve ``node`` / ``nodeId`` / ``nodePath`` to one node id.

    ``node`` is looked up as an ID first and as a Node_Path otherwise. Every
    supplied locator must resolve to the same node (400 ``locator_conflict``);
    several matches are 409 ``ambiguous_path`` (at most 50 candidates); no match is
    404 ``node_not_found`` echoing the supplied value.
    """
    given = {k: params.get(k) for k in ("node", "nodeId", "nodePath") if params.get(k) not in (None, "")}
    for name, value in given.items():
        if not isinstance(value, str):
            raise LocatorError(400, "invalid_request", "%s 必须是文本" % name,
                               {"fields": [{"field": name, "reason": "必须是文本"}]})
    if not given:
        raise LocatorError(400, "locator_required", "需要 node、nodeId 或 nodePath 之一",
                           {"fields": [{"field": "node", "reason": "必填"}]})
    ids = {}
    for name in ("nodeId", "node"):                       # IDs first so a path can use them as a hint
        if name not in given:
            continue
        value = given[name]
        if _ID.match(value) and _exists(con, value):
            ids[name] = value
        elif name == "nodeId":
            raise _not_found(value)
    hint = next(iter(ids.values()), None)
    resolved = dict(ids)
    if "node" in given and "node" not in ids:
        resolved["node"] = _by_path(con, given["node"], hint)
    if "nodePath" in given:
        resolved["nodePath"] = _by_path(con, given["nodePath"], hint)
    if len(set(resolved.values())) > 1:
        raise LocatorError(400, "locator_conflict", "node / nodeId / nodePath 指向不同的节点",
                           {"locators": resolved})
    return next(iter(resolved.values()))
