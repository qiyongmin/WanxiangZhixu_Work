"""Agent write core and Change_Proposal (design 4.12 / 4.13). No network, no AI-provider calls.

An external desktop Agent talks to ``/api/work-hub/agent/*``. Additive content (Note, Material,
report, Summary, new Task) is stored at once and marked ``unconfirmed`` in ``work_agent_writes``
(same transaction as the content and its Revision). Human-owned fields can only change through a
Change_Proposal that the user approves. Everything here runs through ``work_hub_nodes`` /
``work_hub_store`` transactions, so a failure at any step leaves nothing behind.
"""
from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import re
import sys
import unicodedata
import uuid

import work_hub_ext as ext
import work_hub_html
import work_hub_nodes as nodes
import work_hub_notes
import work_hub_paths as paths
import work_hub_sections as sections
import work_hub_store as store

ACTOR_RE = re.compile(r"agent:[^\s\x00-\x1f\x7f]{1,75}\Z")
CLIENT_RE = re.compile(r"[\w.:/-]{1,30}\Z")
HUMAN_OWNED = ("status", "dueDate", "owner", "assignee", "title", "parent_id", "parentId")
HUMAN_REASON = "人工专属字段，请改用 Change_Proposal"
LOCATORS = ("node", "nodeId", "nodePath")
MAX_REPORT_BYTES = 10 * 1024 * 1024
DEFAULT_LIMIT = 20
MAX_LIMIT = 100
PROPOSAL_KEYS = ("title", "status", "data", "parent_id")
PROTECTED_DATA_KEYS = ("noteEntries", "summaryBlock", "customFields")
MAX_RATIONALE = 2000
MAX_EVIDENCE = 20
MAX_EVIDENCE_ITEM = 2000
REPORT_FOLDER = "Projects/WorkHub/Reports"
WRITE_STATES = ("unconfirmed", "confirmed", "undone")


# --------------------------------------------------------------------------
# Request validation helpers (all run before anything is written)
# --------------------------------------------------------------------------
def _object(body):
    if not isinstance(body, dict):
        raise nodes.NodeError("请求体必须是对象", code="invalid_body")
    return body


def _actor(body):
    actor = body.get("actor")
    if not isinstance(actor, str) or not ACTOR_RE.match(actor):
        raise nodes.NodeError("actor 缺失或格式无效（须为 agent:<名称>，无空白与控制字符，总长 ≤ 81）",
                              code="actor_invalid",
                              details={"fields": [{"field": "actor", "reason": "须匹配 ^agent:[^\\s]{1,75}$"}]})
    return actor


def _source(op, client):
    if isinstance(client, str) and CLIENT_RE.match(client):
        return "agent-api:%s@%s" % (op, client)
    return "agent-api:" + op


def _screen(body, allowed):
    """Reject Human_Owned_Field (code ``human_owned_field``) and unknown fields, listing every offender."""
    allowed = set(allowed) | {"actor"}
    human = [k for k in body if k in HUMAN_OWNED and k not in allowed]
    unknown = [k for k in body if k not in allowed and k not in HUMAN_OWNED]
    if human:
        fields = [{"field": k, "reason": HUMAN_REASON} for k in human] + \
                 [{"field": k, "reason": "不支持的字段"} for k in unknown]
        raise nodes.NodeError("字段只能由用户修改，请改用 Change_Proposal: " + ", ".join(human),
                              code="human_owned_field", details={"fields": fields})
    if unknown:
        raise nodes._fields_error([(k, "不支持的字段") for k in unknown])


def _locators(body, extra=()):
    found = {k: body[k] for k in LOCATORS + tuple(extra) if body.get(k) not in (None, "")}
    if "parent" in found:
        found.setdefault("node", found.pop("parent"))
    return found


def _locate(con, body, extra=()):
    return paths.locate(con, _locators(body, extra))


def _base(body, required=True):
    if body.get("baseRevision") is None:
        if required:
            raise nodes.NodeError("缺少 baseRevision", code="base_revision_required",
                                  details={"fields": [{"field": "baseRevision", "reason": "必填"}]})
        return None
    value = body["baseRevision"]
    if type(value) is not int or value < 1:
        raise nodes._fields_error([("baseRevision", "必须是正整数")])
    return value


def _text(body, key, low, high, required=True):
    value = body.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str) or not low <= len(value.strip()) <= high:
        raise nodes._fields_error([(key, "必须是 %d 到 %d 个字符" % (low, high))])
    return value.strip()


def _sha(*parts):
    digest = hashlib.sha256()
    for part in parts:
        digest.update(part.encode("utf-8"))
    return digest.hexdigest()


def _section_message(exc):
    rule = "departmentSummaryOnly"
    return nodes.NodeError("违反 Section_Rule（%s）：Team Management 只允许部门汇总，不得写入个人员工评价数据（%s）"
                           % (rule, str(exc)), code="section_rule_violation", details=dict(exc.details, rule=rule))


@contextlib.contextmanager
def _tx(path):
    """A migrated write transaction that reports Section_Rule violations in the Agent's terms."""
    try:
        with nodes._writer(path) as con:
            yield con
    except sections.SectionRuleViolation as exc:
        raise _section_message(exc) from None


def _tree_record(con, node_id):
    record = nodes._row_or_404(con, node_id)
    if record["kind"] not in sections.TREE_KINDS:
        raise nodes.NodeError("该类型的节点不接受 Agent 写入", code="invalid_request",
                              details={"fields": [{"field": "node", "reason": "不是树节点"}]})
    return record


def _register(con, record_id, op, ref, actor, source, node_revision, content_hash, before):
    write_id = "aw-" + uuid.uuid4().hex
    con.execute("""INSERT INTO work_agent_writes(write_id,record_id,op,ref,actor,source,node_revision,
                   content_hash,before_json,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,'unconfirmed',?)""",
                (write_id, record_id, op, ref, actor, source, node_revision, content_hash,
                 json.dumps(before, ensure_ascii=False) if before is not None else None, store._now()))
    return write_id


# --------------------------------------------------------------------------
# Writes
# --------------------------------------------------------------------------
def _note_hash(entry):
    return _sha(entry["title"], entry["html"])


def add_note(body, path=None, client=None):
    body = _object(body)
    actor = _actor(body)
    _screen(body, LOCATORS + ("baseRevision", "title", "markdown", "html"))
    title = _text(body, "title", 1, work_hub_notes.V2_MAX_TITLE)
    base = _base(body)
    has_md, has_html = body.get("markdown") is not None, body.get("html") is not None
    if has_md == has_html:
        raise nodes.NodeError("markdown 与 html 必须二选一", code="invalid_request",
                              details={"fields": [{"field": "markdown", "reason": "markdown 与 html 必须且只能提供一个"}]})
    warnings = []
    if has_md:
        try:
            converted = work_hub_html.markdown_to_html(body["markdown"])
        except work_hub_html.ContentError as exc:
            raise nodes.NodeError(str(exc), code=exc.code, details={
                "fields": [{"field": "markdown", "reason": str(exc)}], **exc.details}) from None
        html_text, warnings = converted["html"], converted["warnings"]
    else:
        html_text = body["html"]
        if not isinstance(html_text, str):
            raise nodes._fields_error([("html", "必须是文本")])
    entry = {"id": "note_" + uuid.uuid4().hex[:16], "title": title, "html": html_text}
    try:
        nodes.validate_note_entries([entry])                  # strict whitelist, 1 MiB per note
    except nodes.NodeError as exc:
        for item in exc.details.get("fields", []):
            item["field"] = item["field"].replace("entries[0].", "")
        raise
    source = _source("add_note", client)
    with _tx(path) as con:
        record = nodes._editable(con, _locate(con, body), {"baseRevision": base})
        _tree_record(con, record["id"])
        if con.execute("SELECT value FROM work_meta WHERE key='notebook_v3_ready'").fetchone():
            import work_notebook as notebook
            section=notebook._find_or_create(con,record['id'],'general','General')
            page=notebook._make_page(con,record['id'],section['id'],entry['title'],entry['html'])
            con.execute('UPDATE work_note_page_revisions SET actor=?,source=? WHERE page_id=? AND revision=1',
                        (actor,source,page['id']))
            saved=nodes._save(con,nodes._payload_for(record),source,actor=actor)
            write_id=_register(con,record['id'],'add_note',page['id'],actor,source,saved['revision'],
                               _note_hash(entry),None)
            result={'nodeId':record['id'],'revision':saved['revision'],
                    'noteId':page['id'],'pageId':page['id'],'writeId':write_id}
            if warnings:result['warnings']=warnings
            return result
        existing = record["data"].get("noteEntries") if isinstance(record["data"].get("noteEntries"), list) else []
        if len(existing) >= work_hub_notes.V2_MAX_NOTES:
            raise nodes.NodeError("该节点已有 %d 条 Note（上限）" % len(existing), code="too_many_notes")
        data = copy.deepcopy(record["data"])
        data["noteEntries"] = [*existing, entry]
        saved = nodes._save(con, nodes._payload_for(record, data=data), source, actor=actor)
        write_id = _register(con, record["id"], "add_note", entry["id"], actor, source, saved["revision"],
                             _note_hash(entry), None)
    result = {"nodeId": record["id"], "revision": saved["revision"], "noteId": entry["id"], "writeId": write_id}
    if warnings:
        result["warnings"] = warnings
    return result


def add_material(body, path=None, client=None):
    body = _object(body)
    actor = _actor(body)
    _screen(body, LOCATORS + ("baseRevision", "type", "title", "url", "fileId"))
    base = _base(body)
    if body.get("type") not in ("file", "link"):
        raise nodes._fields_error([("type", "必须是 file 或 link（报告请使用 /agent/report）")])
    spec = nodes.validate_material(body)
    source = _source("add_material", client)
    with _tx(path) as con:
        record = nodes._editable(con, _locate(con, body), {"baseRevision": base})
        _tree_record(con, record["id"])
        material_id, saved = nodes.add_material_tx(con, record, spec, actor=actor, source=source, origin="agent")
        write_id = _register(con, record["id"], "add_material", material_id, actor, source, saved["revision"],
                             _material_hash(con, material_id), None)
    return {"nodeId": record["id"], "revision": saved["revision"], "materialId": material_id, "writeId": write_id}


def _material_hash(con, material_id):
    row = con.execute("SELECT title,data FROM records WHERE id=?", (material_id,)).fetchone()
    return _sha(row["title"], row["data"]) if row else ""


def _slug(title):
    folded = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode("ascii").lower()
    return re.sub(r"[^a-z0-9]+", "-", folded).strip("-")[:40] or "report"


def _prepare_report_folder(hub):
    for folder in ("Projects/WorkHub", REPORT_FOLDER):
        try:
            hub.folder_create(folder)
        except hub.Conflict as exc:
            if str(exc) != "Folder exists":
                raise


def _trash_file(hub, file_id):
    """Compensation for a report whose database write failed: ``trash`` only, never ``purge``."""
    try:
        hub.lifecycle(file_id, hub.details(file_id)["revision"], "trash", True)
    except Exception as exc:  # noqa: BLE001 - the original failure is what the caller must see
        print("work_hub_agent: could not trash orphan report %s: %s" % (file_id, exc), file=sys.stderr)


def upload_report(body, path=None, client=None):
    body = _object(body)
    actor = _actor(body)
    _screen(body, LOCATORS + ("baseRevision", "title", "format", "content"))
    base = _base(body)
    title = _text(body, "title", 1, nodes.MAX_TITLE)
    fmt = body.get("format")
    if fmt not in ("md", "html"):
        raise nodes._fields_error([("format", "必须是 md 或 html")])
    content = body.get("content")
    if not isinstance(content, str) or content == "":
        raise nodes._fields_error([("content", "必须是非空文本")])
    raw = content.encode("utf-8")
    if len(raw) > MAX_REPORT_BYTES:
        raise nodes.NodeError("报告不能超过 10 MiB", code="report_too_large",
                              details={"fields": [{"field": "content", "reason": "超过 10 MiB"}]})
    source = _source("upload_report", client)
    # 1) read-only pre-check so a conflict / bad locator never leaves an orphan file behind
    with nodes._reader(path) as con:
        node_id = _locate(con, body)
        nodes._check_revision(nodes._row_or_404(con, node_id), base)
        _tree_record(con, node_id)
    hub = nodes._file_hub()
    if hub is None:
        raise nodes.NodeError("File Hub 未启用，无法保存报告", code="file_hub_unavailable", status=503)
    # 2) File Hub first (cannot share a transaction with SQLite) ...
    _prepare_report_folder(hub)
    name = "agent-report-%s-%s.%s" % (uuid.uuid4().hex[:8], _slug(title), fmt)
    uploaded = hub.upload(REPORT_FOLDER, name, raw)
    file_id = uploaded["id"]
    # 3) ... then one database transaction; on any failure trash the file and report 500
    try:
        with _tx(path) as con:
            record = nodes._editable(con, node_id, {"baseRevision": base})
            spec = {"type": "report", "title": title, "fileId": file_id, "format": fmt}
            material_id, saved = nodes.add_material_tx(con, record, spec, actor=actor, source=source, origin="agent")
            write_id = _register(con, node_id, "upload_report", material_id, actor, source, saved["revision"],
                                 _material_hash(con, material_id), None)
    except nodes.NodeError as exc:
        _trash_file(hub, file_id)
        if exc.status < 500:
            raise
        raise nodes.NodeError("报告保存失败，已回滚", code="internal_error", status=500) from exc
    except Exception as exc:
        _trash_file(hub, file_id)
        raise nodes.NodeError("报告保存失败，已回滚", code="internal_error", status=500) from exc
    return {"nodeId": node_id, "revision": saved["revision"], "materialId": material_id, "fileId": file_id,
            "writeId": write_id}


def update_summary(body, path=None, client=None):
    body = _object(body)
    actor = _actor(body)
    _screen(body, LOCATORS + ("baseRevision", "markdown"))
    base = _base(body)
    text = body.get("markdown")
    try:
        block = work_hub_html.render_summary(text)
    except work_hub_html.ContentError as exc:
        raise nodes.NodeError(str(exc), code=exc.code, details={
            "fields": [{"field": "markdown", "reason": str(exc)}], **exc.details}) from None
    source = _source("update_summary", client)
    with _tx(path) as con:
        record = nodes._editable(con, _locate(con, body), {"baseRevision": base})
        _tree_record(con, record["id"])
        old = record["data"].get("summaryBlock")
        data = copy.deepcopy(record["data"])
        data["summaryBlock"] = block
        saved = nodes._save(con, nodes._payload_for(record, data=data), source, actor=actor)
        write_id = _register(con, record["id"], "update_summary", "summary", actor, source, saved["revision"],
                             _sha(block["text"]), {"summaryBlock": old if isinstance(old, dict) else None})
    return {"nodeId": record["id"], "revision": saved["revision"], "writeId": write_id}


def add_task(body, path=None, client=None):
    body = _object(body)
    actor = _actor(body)
    _screen(body, LOCATORS + ("parent", "baseRevision", "title", "description", "priority", "tags"))
    title = _text(body, "title", 1, nodes.MAX_TITLE)
    base = _base(body, required=False)
    problems, data = [], {}
    if body.get("description") is not None:
        description, reason = nodes._validate_description(body["description"])
        if reason:
            problems.append(("description", reason))
        elif description:
            data["description"] = description
    priority, reason = ext.check_priority(body["priority"]) if body.get("priority") is not None \
        else (ext.DEFAULT_PRIORITY, None)
    if reason:
        problems.append(("priority", reason))
    data["priority"] = priority
    tags, reason = ext.check_tags(body.get("tags"))
    if reason:
        problems.append(("tags", reason))
    if problems:
        raise nodes._fields_error(problems)
    source = _source("add_task", client)
    task_id = "work-" + uuid.uuid4().hex
    with _tx(path) as con:
        parent_id = _locate(con, body, ("parent",))
        parent = _tree_record(con, parent_id)
        if base is not None:
            nodes._check_revision(parent, base)
        con.execute("PRAGMA defer_foreign_keys=ON")
        if tags:
            ext.set_tags(con, task_id, tags, store._now())
        snapshot = ext.snapshot(con, task_id)
        saved = nodes._save(con, {"id": task_id, "kind": "task", "title": title, "status": "Planned",
                                  "parent_id": parent_id, "data": data, "revision": 0}, source,
                            extra={"ext": snapshot} if snapshot else None, actor=actor)
        write_id = _register(con, task_id, "add_task", task_id, actor, source, saved["revision"],
                             _sha(title, json.dumps(data, sort_keys=True, ensure_ascii=False)), None)
    return {"nodeId": task_id, "revision": saved["revision"], "writeId": write_id}


# --------------------------------------------------------------------------
# Confirm / undo (user actions)
# --------------------------------------------------------------------------
def _write_row(con, write_id):
    row = con.execute("SELECT * FROM work_agent_writes WHERE write_id=?", (write_id,)).fetchone()
    if row is None:
        raise nodes.NodeError("Agent 写入不存在: %s" % write_id, code="write_not_found", status=404,
                              details={"value": write_id})
    if row["state"] != "unconfirmed":
        raise nodes.NodeError("该 Agent 写入已是 %s，不能再确认或撤销" % row["state"], code="not_unconfirmed",
                              status=409, details={"state": row["state"]})
    return row


def _write_dto(con, write_id):
    row = con.execute("SELECT * FROM work_agent_writes WHERE write_id=?", (write_id,)).fetchone()
    return {"writeId": row["write_id"], "nodeId": row["record_id"], "op": row["op"], "ref": row["ref"],
            "actor": row["actor"], "state": row["state"], "createdAt": row["created_at"],
            "resolvedAt": row["resolved_at"], "resolvedRevision": row["resolved_revision"]}


def _resolve(con, write_id, state, revision):
    con.execute("UPDATE work_agent_writes SET state=?,resolved_at=?,resolved_by='user',resolved_revision=? "
                "WHERE write_id=?", (state, store._now(), revision, write_id))


def agent_confirm(body, path=None):
    """Mark an Agent write confirmed: one Revision (actor ``user``), content unchanged."""
    body = nodes._body(body)
    write_id = nodes._node_id(body, "writeId")
    with _tx(path) as con:
        write = _write_row(con, write_id)
        row = con.execute("SELECT * FROM records WHERE id=?", (write["record_id"],)).fetchone()
        if row is None or row["deleted_at"]:
            raise nodes.NodeError("目标节点已删除，无法确认", code="target_unavailable", status=409)
        record = store._serialize(row)
        change = {"type": "confirm", "writeId": write_id, "confirmedAt": store._now()}
        saved = nodes._save(con, nodes._payload_for(record), "confirm:" + write_id, extra={"_change": change})
        _resolve(con, write_id, "confirmed", saved["revision"])
        return {"write": _write_dto(con, write_id), "node": nodes._dto(con, record["id"])}


def _modified(message="该内容在 Agent 写入之后被修改过，不能撤销（仍可确认）"):
    return nodes.NodeError(message, code="modified_since", status=409)


def _undo_note(con, write, record):
    if con.execute("SELECT value FROM work_meta WHERE key='notebook_v3_ready'").fetchone():
        page=con.execute('SELECT * FROM work_note_pages WHERE owner_id=? AND (id=? OR legacy_id=?)',
                         (record['id'],write['ref'],write['ref'])).fetchone()
        if not page or page['archived_at'] or _sha(page['title'],page['html'])!=write['content_hash']:
            raise _modified()
        now=store._now()
        con.execute('UPDATE work_note_pages SET archived_at=?,revision=revision+1,updated_at=? WHERE id=?',
                    (now,now,page['id']))
        con.execute('INSERT INTO work_note_page_revisions VALUES(?,?,?,?,?,?,?)',
                    (page['id'],page['revision']+1,page['title'],page['html'],'user','agent:undo:'+write['write_id'],now))
        return nodes._save(con,nodes._payload_for(record),'undo:'+write['write_id'],
                           extra={'_change':{'type':'undo','writeId':write['write_id']}})
    entries = record["data"].get("noteEntries")
    entries = entries if isinstance(entries, list) else []
    current = next((e for e in entries if isinstance(e, dict) and e.get("id") == write["ref"]), None)
    if current is None or _note_hash(current) != write["content_hash"]:
        raise _modified()
    data = copy.deepcopy(record["data"])
    data["noteEntries"] = [e for e in entries if e is not current]
    return nodes._save(con, nodes._payload_for(record, data=data), "undo:" + write["write_id"],
                       extra={"_change": {"type": "undo", "writeId": write["write_id"]}})


def _undo_summary(con, write, record):
    block = record["data"].get("summaryBlock")
    text = block.get("text", "") if isinstance(block, dict) else ""
    if _sha(text) != write["content_hash"]:
        raise _modified()
    before = (json.loads(write["before_json"]) if write["before_json"] else {}).get("summaryBlock")
    data = copy.deepcopy(record["data"])
    if isinstance(before, dict):
        data["summaryBlock"] = before
    else:
        data.pop("summaryBlock", None)
    return nodes._save(con, nodes._payload_for(record, data=data), "undo:" + write["write_id"],
                       extra={"_change": {"type": "undo", "writeId": write["write_id"]}})


def _undo_material(con, write, record):
    material_id = write["ref"]
    linked = con.execute("SELECT 1 FROM links WHERE source_id=? AND target_id=? AND relation='reference'",
                         (record["id"], material_id)).fetchone()
    material = con.execute("SELECT title,data,deleted_at FROM records WHERE id=?", (material_id,)).fetchone()
    if not linked or material is None or material["deleted_at"] or \
            _sha(material["title"], material["data"]) != write["content_hash"]:
        raise _modified()
    return nodes.remove_material_link_tx(con, record, material_id, actor="user", source="undo:" + write["write_id"],
                                         change={"type": "undo", "writeId": write["write_id"]})


def _undo_task(con, write, record):
    children = con.execute("SELECT COUNT(*) FROM records WHERE parent_id=? AND deleted_at IS NULL",
                           (record["id"],)).fetchone()[0]
    if record["revision"] != write["node_revision"] or children:
        raise _modified()
    return store._lifecycle_tx(con, record["id"], record["revision"], "delete", "user", "undo:" + write["write_id"],
                               blocking_children="active",
                               extra={"_change": {"type": "undo", "writeId": write["write_id"]}})


_UNDO = {"add_note": _undo_note, "update_summary": _undo_summary, "add_material": _undo_material,
         "upload_report": _undo_material, "add_task": _undo_task}


def agent_undo(body, path=None):
    """Restore the pre-write content when it has not been touched since; never deletes the Agent Revision."""
    body = nodes._body(body)
    write_id = nodes._node_id(body, "writeId")
    with _tx(path) as con:
        write = _write_row(con, write_id)
        row = con.execute("SELECT * FROM records WHERE id=?", (write["record_id"],)).fetchone()
        if row is None or row["deleted_at"]:
            raise _modified("目标节点已删除，不能撤销")
        saved = _UNDO[write["op"]](con, write, store._serialize(row))
        _resolve(con, write_id, "undone", saved["revision"])
        return {"write": _write_dto(con, write_id), "node": nodes._dto(con, write["record_id"], allow_deleted=True)}


# --------------------------------------------------------------------------
# Reads
# --------------------------------------------------------------------------
def _limit(params, name="limit"):
    return nodes._int_param(params.get(name), name, DEFAULT_LIMIT, 1, MAX_LIMIT)


def node_read(params, path=None):
    with nodes._reader(path) as con:
        node_id = _locate(con, params)
    dto = nodes.node_view(id=node_id, path=path)
    keep = ("id", "kind", "displayKind", "parentId", "title", "status", "revision", "nodePath", "path", "description",
            "priority", "dueDate", "tags", "summary", "childCount", "stats", "unconfirmed", "sectionId",
            "archivedAt", "updatedAt")
    result = {k: dto[k] for k in keep}
    with nodes._reader(path) as con:
        is_v3=bool(con.execute("SELECT value FROM work_meta WHERE key='notebook_v3_ready'").fetchone())
    if is_v3:
        import work_notebook as notebook
        pages=notebook.pages_view({'id':node_id,'limit':100},path=path)
        result['notes']=[{'id':p['id'],'title':p['title']} for p in pages['items']]
        result['noteTotal']=pages['total']
    else:
        notes = nodes.notes_view(node_id, path=path)
        result["notes"] = [{"id": n["id"], "title": n["title"]} for n in notes["items"]]
    return result


def children_read(params, path=None):
    limit, offset = _limit(params), nodes._int_param(params.get("offset"), "offset", 0, 0, 10 ** 9)
    with nodes._reader(path) as con:
        node_id = _locate(con, params)
        view = nodes.children_view(node_id, limit=limit, offset=offset, path=path)
        for item in view["items"]:
            item["nodePath"] = paths.node_path_of(con, item["id"])
    return view


def search_read(params, path=None):
    limit, offset = _limit(params), nodes._int_param(params.get("offset"), "offset", 0, 0, 10 ** 9)
    section = params.get("section")
    section = (section[0] if section else None) if isinstance(section, list) else section
    q = params.get("q")
    q = q[0] if isinstance(q, list) else q
    hits = nodes.search_view(q, limit=offset + limit, section=section or None, path=path,
                             max_limit=offset + MAX_LIMIT)
    return {"items": hits[offset:offset + limit]}


def proposal_read(params, path=None):
    pid = nodes._node_id(params, "id")
    with nodes._reader(path) as con:
        row = _proposal_row(con, pid)
        return _proposal_dto(con, row, brief=True)


# --------------------------------------------------------------------------
# Change_Proposal
# --------------------------------------------------------------------------
def _json_list(text):
    try:
        value = json.loads(text) if text else []
    except ValueError:
        return [text] if text else []
    return value if isinstance(value, list) else [value]


def _proposal_row(con, proposal_id):
    row = con.execute("""SELECT p.*,m.proposer,m.decided_by,m.decided_at,m.decision,m.reason,m.applied_revision
                         FROM proposals p LEFT JOIN work_proposal_meta m ON m.proposal_id=p.id WHERE p.id=?""",
                      (proposal_id,)).fetchone()
    if row is None:
        raise nodes.NodeError("提案不存在: %s" % proposal_id, code="proposal_not_found", status=404,
                              details={"value": proposal_id})
    return row


def _patched(record, changes):
    """The record fields after applying ``changes`` (``data`` is a shallow patch, ``None`` deletes a key)."""
    out = {"title": record["title"], "status": record["status"], "parent_id": record["parent_id"],
           "data": copy.deepcopy(record["data"])}
    for key in ("title", "status", "parent_id"):
        if key in changes:
            out[key] = changes[key]
    for key, value in (changes.get("data") or {}).items():
        if value is None:
            out["data"].pop(key, None)
        else:
            out["data"][key] = value
    return out


def _simulate_unchecked(con, row, changes):
    """Validate ``changes`` as the approval would apply them (Depth, Section_Rule, hierarchy); writes nothing."""
    record = store._serialize(row)
    after = _patched(record, changes)
    if "title" in changes:
        after["title"], reason = nodes._validate_title(changes["title"])
        if reason:
            raise nodes._fields_error([("changes.title", reason)])
    payload = nodes._payload_for(record, **after)
    with work_hub_notes.relaxed():
        plan = store._normalize_save(con, payload, "user", "proposal:simulate")
    store._parent_check(con, plan["parent_id"], record["kind"])
    if record["parent_id"] != plan["parent_id"]:
        store._validate_hierarchy(con, record["id"], plan["parent_id"], is_new=False)
        nodes._check_subtree_rule(con, record["id"], plan["parent_id"], record["kind"])
    return after


def _simulate(con, row, changes):
    """``_simulate_unchecked`` with plain ``ValueError`` rules reported as a 400 ``invalid_changes``."""
    try:
        return _simulate_unchecked(con, row, changes)
    except (nodes.NodeError, store.HierarchyError, sections.SectionRuleViolation):
        raise
    except ValueError as exc:
        raise nodes.NodeError("changes 无效: %s" % exc, code="invalid_changes",
                              details={"fields": [{"field": "changes", "reason": str(exc)}]}) from None


def _validate_changes(changes):
    if not isinstance(changes, dict) or not changes:
        raise nodes._fields_error([("changes", "必须是至少包含一个字段的对象")])
    extra = sorted(set(changes) - set(PROPOSAL_KEYS))
    if extra:
        raise nodes.NodeError("changes 含不允许的字段: " + ", ".join(extra), code="invalid_changes",
                              details={"fields": [{"field": "changes." + k, "reason": "不允许的字段"} for k in extra]})
    if "data" in changes:
        patch = changes["data"]
        if not isinstance(patch, dict):
            raise nodes._fields_error([("changes.data", "必须是对象")])
        bad = sorted(set(patch) & set(PROTECTED_DATA_KEYS))
        if bad:
            raise nodes.NodeError("changes.data 不得修改: " + ", ".join(bad), code="invalid_changes", details={
                "fields": [{"field": "changes.data." + k, "reason": "请使用对应的 Agent 端点"} for k in bad]})
    return changes


def submit_proposal(body, path=None, client=None):
    body = _object(body)
    actor = _actor(body)
    _screen(body, LOCATORS + ("baseRevision", "changes", "rationale", "evidence"))
    base = _base(body)
    changes = _validate_changes(body.get("changes"))
    rationale = _text(body, "rationale", 1, MAX_RATIONALE)
    evidence = body.get("evidence", [])
    if evidence is None:
        evidence = []
    if not isinstance(evidence, list) or len(evidence) > MAX_EVIDENCE or \
            any(not isinstance(e, str) or len(e) > MAX_EVIDENCE_ITEM for e in evidence):
        raise nodes._fields_error([("evidence", "最多 %d 条，每条为不超过 %d 字符的文本"
                                    % (MAX_EVIDENCE, MAX_EVIDENCE_ITEM))])
    with _tx(path) as con:
        try:
            node_id = _locate(con, body)
        except paths.LocatorError as exc:
            if exc.code != "node_not_found":
                raise
            raise nodes.NodeError("目标节点不存在或已删除", code="target_unavailable", status=404,
                                  details=exc.details) from None
        row = nodes._row_or_404(con, node_id)
        nodes._check_revision(row, base)
        _simulate(con, row, changes)
        proposal_id = "proposal-" + uuid.uuid4().hex
        now = store._now()
        con.execute("INSERT INTO proposals(id,record_id,base_revision,changes_json,rationale,evidence,status,"
                    "created_at,reviewed_at) VALUES(?,?,?,?,?,?,'pending',?,NULL)",
                    (proposal_id, node_id, base, json.dumps(changes, ensure_ascii=False), rationale,
                     json.dumps(evidence, ensure_ascii=False), now))
        con.execute("INSERT INTO work_proposal_meta(proposal_id,proposer) VALUES(?,?)", (proposal_id, actor))
    return {"nodeId": node_id, "revision": base, "proposalId": proposal_id, "status": "pending"}


def _proposal_dto(con, row, brief=False):
    changes = json.loads(row["changes_json"])
    target = con.execute("SELECT * FROM records WHERE id=?", (row["record_id"],)).fetchone()
    result = {"id": row["id"], "nodeId": row["record_id"], "status": row["status"], "proposer": row["proposer"],
              "rationale": row["rationale"], "evidence": _json_list(row["evidence"]), "baseRevision": row["base_revision"],
              "createdAt": row["created_at"], "decidedAt": row["decided_at"], "decidedBy": row["decided_by"],
              "decision": row["decision"], "reason": row["reason"], "appliedRevision": row["applied_revision"]}
    if brief:
        return result
    current = store._serialize(target) if target is not None else None
    before, after = {}, {}
    if current is not None:
        for key in ("title", "status", "parent_id"):
            if key in changes:
                before[key], after[key] = current[key], changes[key]
        if "data" in changes:
            before["data"] = {k: current["data"].get(k) for k in changes["data"]}
            after["data"] = changes["data"]
    result.update(changes=changes, before=before, after=after,
                  nodeTitle=current["title"] if current else None,
                  nodePath=paths.node_path_of(con, row["record_id"]) if target is not None else None,
                  currentRevision=current["revision"] if current else None,
                  stale=bool(current is None or current["revision"] != row["base_revision"]
                             or current["deleted_at"]))
    return result


def change_proposals_view(params, path=None):
    status = params.get("status")
    status = (status[0] if status else None) if isinstance(status, list) else status
    status = status or "pending"
    if status not in ("pending", "all"):
        raise nodes._fields_error([("status", "必须是 pending 或 all")])
    with nodes._reader(path) as con:
        rows = con.execute("""SELECT p.*,m.proposer,m.decided_by,m.decided_at,m.decision,m.reason,m.applied_revision
                              FROM proposals p JOIN work_proposal_meta m ON m.proposal_id=p.id
                              WHERE (?='all' OR p.status='pending') ORDER BY p.created_at DESC,p.id DESC""",
                           (status,)).fetchall()
        return [_proposal_dto(con, row) for row in rows]


def _mark_approved(con, proposal_id, applied_revision):
    now = store._now()
    con.execute("UPDATE proposals SET status='approved',reviewed_at=? WHERE id=?", (now, proposal_id))
    con.execute("UPDATE work_proposal_meta SET decided_by='user',decided_at=?,decision='approved',"
                "applied_revision=? WHERE proposal_id=?", (now, applied_revision, proposal_id))


def proposal_approve(body, path=None):
    """Apply a pending proposal atomically (single transaction) with the proposer as Revision actor."""
    body = nodes._body(body)
    proposal_id = nodes._node_id(body)
    expired = False
    result = None
    with _tx(path) as con:
        row = _proposal_row(con, proposal_id)
        if row["status"] != "pending":
            raise nodes.NodeError("提案已是 %s，不能再批准" % row["status"], code="proposal_closed", status=409)
        target = con.execute("SELECT * FROM records WHERE id=?", (row["record_id"],)).fetchone()
        if target is None or target["deleted_at"] or target["revision"] != row["base_revision"]:
            now = store._now()
            con.execute("UPDATE proposals SET status='expired',reviewed_at=? WHERE id=?", (now, proposal_id))
            con.execute("UPDATE work_proposal_meta SET decided_by='user',decided_at=?,decision='expired' "
                        "WHERE proposal_id=?", (now, proposal_id))
            expired = True                                   # committed below, then reported as 409
        else:
            changes = json.loads(row["changes_json"])
            after = _simulate(con, target, changes)         # rule / Depth violations: 400, proposal stays pending
            try:
                saved = nodes._save(con, nodes._payload_for(store._serialize(target), **after),
                                    "proposal:" + proposal_id, actor=row["proposer"] or "agent:unknown")
                _mark_approved(con, proposal_id, saved["revision"])
            except nodes.NodeError:
                raise
            except Exception as exc:  # noqa: BLE001 - everything rolls back; the proposal stays pending
                print("work_hub_agent: approval failed: %r" % (exc,), file=sys.stderr)
                raise nodes.NodeError("批准失败，操作已回滚，提案仍待处理", code="approval_failed",
                                      status=500) from exc
            result = {"proposal": _proposal_dto(con, _proposal_row(con, proposal_id), brief=True),
                      "node": nodes._dto(con, row["record_id"])}
    if expired:
        raise nodes.NodeError("目标节点已变化，提案已过期", code="proposal_expired", status=409)
    return result


def proposal_reject(body, path=None):
    body = nodes._body(body)
    proposal_id = nodes._node_id(body)
    reason = body.get("reason")
    if reason is not None and (not isinstance(reason, str) or len(reason) > MAX_RATIONALE):
        raise nodes._fields_error([("reason", "必须是不超过 %d 字符的文本" % MAX_RATIONALE)])
    with _tx(path) as con:
        row = _proposal_row(con, proposal_id)
        if row["status"] != "pending":
            raise nodes.NodeError("提案已是 %s，不能再拒绝" % row["status"], code="proposal_closed", status=409)
        now = store._now()
        con.execute("UPDATE proposals SET status='rejected',reviewed_at=? WHERE id=?", (now, proposal_id))
        con.execute("UPDATE work_proposal_meta SET decided_by='user',decided_at=?,decision='rejected',reason=? "
                    "WHERE proposal_id=?", (now, reason, proposal_id))
        return {"proposal": _proposal_dto(con, _proposal_row(con, proposal_id), brief=True)}


# --------------------------------------------------------------------------
# view=agent-writes
# --------------------------------------------------------------------------
def _second(stamp):
    return re.sub(r"\.\d+(?=[+-]|Z|$)", "", stamp or "")


def agent_writes_view(params, path=None):
    limit = nodes._int_param(params.get("limit"), "limit", 50, 1, 100)
    actor, state = params.get("actor") or None, params.get("state") or None
    if state is not None and state not in WRITE_STATES + ("approved",):
        raise nodes._fields_error([("state", "必须是 %s 之一" % " / ".join(WRITE_STATES + ("approved",)))])
    start, end = params.get("from") or None, params.get("to") or None
    for name, value in (("from", start), ("to", end)):
        if value is not None and not (isinstance(value, str) and re.match(r"\d{4}-\d{2}-\d{2}", value)):
            raise nodes._fields_error([(name, "必须是 YYYY-MM-DD 开头的日期或时间")])
    cursor = params.get("cursor") or None
    if cursor is not None and not (isinstance(cursor, str) and "|" in cursor):
        raise nodes._fields_error([("cursor", "无效")])
    after = tuple(cursor.split("|", 1)) if cursor else None
    with nodes._reader(path) as con:
        rows = []
        if state in (None,) + WRITE_STATES:
            for w in con.execute("SELECT * FROM work_agent_writes ORDER BY created_at DESC,write_id DESC"):
                rows.append((w["created_at"], w["write_id"], {
                    "writeId": w["write_id"], "actor": w["actor"], "nodeId": w["record_id"], "op": w["op"],
                    "createdAt": _second(w["created_at"]), "state": w["state"],
                    "resolvedAt": _second(w["resolved_at"]) if w["resolved_at"] else None}))
        if state in (None, "approved"):
            for p in con.execute("""SELECT p.id,p.record_id,m.proposer,m.decided_at FROM proposals p
                                    JOIN work_proposal_meta m ON m.proposal_id=p.id
                                    WHERE p.status='approved' AND m.decided_at IS NOT NULL"""):
                rows.append((p["decided_at"], p["id"], {
                    "writeId": p["id"], "actor": p["proposer"], "nodeId": p["record_id"], "op": "proposal",
                    "createdAt": _second(p["decided_at"]), "state": "approved", "resolvedAt": None}))
        rows = [r for r in rows if (actor is None or r[2]["actor"] == actor)
                and (state is None or r[2]["state"] == state)
                and (start is None or r[0] >= start) and (end is None or r[0][:len(end)] <= end)
                and (after is None or (r[0], r[1]) < after)]
        rows.sort(key=lambda r: (r[0], r[1]), reverse=True)
        page = rows[:limit]
        items = []
        for created, key, item in page:
            node = con.execute("SELECT 1 FROM records WHERE id=?", (item["nodeId"],)).fetchone()
            items.append({**item, "nodePath": paths.node_path_of(con, item["nodeId"]) if node else None})
        more = len(rows) > limit
        return {"items": items, "nextCursor": "%s|%s" % (page[-1][0], page[-1][1]) if more and page else None}


# --------------------------------------------------------------------------
# Router for /api/work-hub/agent/*
# --------------------------------------------------------------------------
AGENT_PREFIX = "/api/work-hub/agent/"
GET_ROUTES = {"node": node_read, "children": children_read, "search": search_read, "proposal": proposal_read}
POST_ROUTES = {"note": add_note, "material": add_material, "report": upload_report, "summary": update_summary,
               "task": add_task, "proposal": submit_proposal}


def is_agent_route(route):
    return isinstance(route, str) and route.startswith(AGENT_PREFIX)


def dispatch(method, route, params, body, db, client=None):
    """``(handler result)`` for a known Agent route; ``None`` when the route is unknown."""
    name = route[len(AGENT_PREFIX):]
    if method == "GET" and name in GET_ROUTES:
        return GET_ROUTES[name](params, path=db)
    if method == "POST" and name in POST_ROUTES:
        return POST_ROUTES[name](body, path=db, client=client)
    return None
