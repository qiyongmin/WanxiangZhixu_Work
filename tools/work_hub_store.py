"""Phase 1 Work Hub store: isolated SQLite, revision-safe records and audit events."""
from __future__ import annotations
import contextlib
import json
import os
import re
import sqlite3
import threading
import work_hub_ext
import work_hub_notes
import work_hub_repeat
import work_hub_sections
import uuid
from datetime import date, datetime, time as dtime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("KB_WORK_HUB_DB", str(ROOT / "content/work-hub/work.sqlite3")))
TYPES = {"initiative", "knowledge_collection", "workstream", "task", "topic", "campaign", "action",
         "milestone", "risk", "decision", "material"}
STATES = {"Planned", "In Progress", "Waiting", "Blocked", "Done"}
MAX_JSON = 8 * 1024 * 1024
MAX_ACTOR = 81
_lock = threading.RLock()

class Conflict(ValueError):
    pass

class NotFound(ValueError):
    pass

MAX_DEPTH = 4
MULTI_PARENT_KEYS = ("parent_ids", "parentIds", "parents")

class HierarchyError(ValueError):
    """Hierarchy rule violation (HTTP 400); raised before anything is written."""
    status = 400

    def __init__(self, code, message, details=None):
        super().__init__(message)
        self.code = code
        self.details = details or {}

def _now():
    return datetime.now(timezone.utc).isoformat()

def _connection(path=None):
    target = Path(path) if path is not None else DB_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(str(target), timeout=10)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA busy_timeout=10000")
    con.execute("""CREATE TABLE IF NOT EXISTS records(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent_id TEXT REFERENCES records(id),
        title TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL,
        data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        archived_at TEXT, deleted_at TEXT)""")
    con.execute("""CREATE TABLE IF NOT EXISTS revisions(
        event_id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id),
        revision INTEGER NOT NULL, actor TEXT NOT NULL, source TEXT NOT NULL,
        before_json TEXT, after_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
        UNIQUE(record_id, revision))""")
    con.execute("""CREATE TABLE IF NOT EXISTS links(
        source_id TEXT NOT NULL REFERENCES records(id), target_id TEXT NOT NULL REFERENCES records(id),
        relation TEXT NOT NULL, PRIMARY KEY(source_id,target_id,relation))""")
    con.execute("""CREATE TABLE IF NOT EXISTS proposals(
       id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id),
       base_revision INTEGER NOT NULL, changes_json TEXT NOT NULL,
       rationale TEXT NOT NULL, evidence TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, reviewed_at TEXT)
    """)
    con.execute("CREATE INDEX IF NOT EXISTS work_kind ON records(kind,status)")
    con.execute("CREATE INDEX IF NOT EXISTS work_parent ON records(parent_id)")
    return con

def _check_record(kind, title, status, data, department_only=None):
    """Validate a record; returns the JSON text of ``data``.

    ``department_only`` is the Section_Rule switch of the record's Section:
    ``None`` = unknown (database not migrated): legacy behaviour, topic/campaign
    reject employee-level keys at the top level of ``data``; ``True`` = reject
    those keys at any nesting level (all kinds); ``False`` = rule disabled.
    """
    if kind not in TYPES: raise ValueError("Unknown record type")
    if not isinstance(title,str) or not title.strip() or len(title)>300: raise ValueError("Invalid title")
    if status not in STATES: raise ValueError("Invalid status")
    if not isinstance(data,dict): raise ValueError("Data must be an object")
    work_hub_notes.validate_entries(data,kind)
    if department_only is None:
        if kind in {'topic','campaign'}:
            forbidden={'employees','employeeIds','employeeProfiles','individualReviews','performanceEvaluations'}
            if forbidden.intersection(data):raise ValueError('Employee-level data is not allowed')
    else:
        work_hub_sections.check_section_rule(data,department_only)
    if kind=='campaign':
        for key in ('total','completed','uncompleted'):
            if key in data and (type(data[key]) is not int or data[key]<0):
                raise ValueError('Invalid department aggregate')
        total,done,remaining=(data.get('total'),data.get('completed'),data.get('uncompleted'))
        if total is not None and done is not None and done>total:
            raise ValueError('Completed exceeds total')
        if total is not None and done is not None and remaining is not None and total!=done+remaining:
            raise ValueError('Department aggregate mismatch')
    raw = json.dumps(data,ensure_ascii=False,allow_nan=False)
    if len(raw.encode("utf-8"))>MAX_JSON: raise ValueError("Record exceeds size limit")
    return raw

def _serialize(row):
    result = dict(row)
    result["data"] = json.loads(result["data"])
    return result

def list_records(kind=None, parent_id=None, include_deleted=False, path=None):
    if kind is not None and kind not in TYPES: raise ValueError("Unknown record type")
    with _lock, _connection(path) as con:
        sql = "SELECT * FROM records WHERE 1=1"
        args = []
        if kind: sql+=" AND kind=?"; args.append(kind)
        if parent_id is not None: sql+=" AND parent_id=?"; args.append(parent_id)
        if not include_deleted: sql+=" AND deleted_at IS NULL"
        return [_serialize(r) for r in con.execute(sql+" ORDER BY updated_at DESC,id", args)]

def get_record(record_id, path=None):
    with _lock, _connection(path) as con:
        row=con.execute("SELECT * FROM records WHERE id=?",(record_id,)).fetchone()
        if row is None: raise NotFound("Record not found")
        return _serialize(row)

def _parent_check(con, parent_id, kind):
    if parent_id is None:
        if kind in {'workstream','task','campaign'}:raise ValueError('Parent required')
        return
    parent=con.execute("SELECT kind,deleted_at FROM records WHERE id=?",(parent_id,)).fetchone()
    if parent is None or parent["deleted_at"]:raise ValueError("Invalid parent")
    # Task is the canonical executable item for both Initiative and Line Management.
    # Historical Action records retain immutable kind/IDs and keep their old parents.
    allowed={"workstream":{"initiative","knowledge_collection"},
             "task":{"initiative","knowledge_collection","workstream","topic","campaign","task","action"},
             "campaign":{"topic"},
             "action":{"campaign","initiative","workstream","task","topic","action"}}
    if kind in allowed and parent["kind"] not in allowed[kind]:raise ValueError("Incompatible parent")
    if kind not in allowed:raise ValueError("This record type must be linked, not nested")

def _multiple_parents():
    return HierarchyError("multiple_parents","每个 Node 最多只能有一个父节点")

def _depth(con, node_id):
    """Depth of ``node_id`` (top level = 1; ``None`` = 0). Cycle-safe."""
    depth=0
    seen=set()
    current=node_id
    while current is not None and current not in seen:
        seen.add(current)
        row=con.execute("SELECT parent_id FROM records WHERE id=?",(current,)).fetchone()
        if row is None:break
        depth+=1
        current=row["parent_id"]
    return depth

def _is_self_or_ancestor(con, record_id, node_id):
    """True when ``record_id`` equals ``node_id`` or is one of its ancestors."""
    seen=set()
    current=node_id
    while current is not None and current not in seen:
        if current==record_id:return True
        seen.add(current)
        row=con.execute("SELECT parent_id FROM records WHERE id=?",(current,)).fetchone()
        if row is None:break
        current=row["parent_id"]
    return False

def _height(con, node_id):
    """Largest relative depth in the subtree of ``node_id`` (0 = no descendants).

    Includes archived and deleted descendants so a later restore cannot exceed
    ``MAX_DEPTH``. The depth cap only guards against corrupt (cyclic) data.
    """
    row=con.execute("""WITH RECURSIVE sub(id,d) AS (
        SELECT ?,0 UNION ALL SELECT r.id,sub.d+1 FROM records r JOIN sub ON r.parent_id=sub.id WHERE sub.d<64)
        SELECT MAX(d) FROM sub""",(node_id,)).fetchone()
    return row[0] or 0

def _validate_hierarchy(con, record_id, new_parent_id, *, is_new):
    """Reject cycles and Depth > ``MAX_DEPTH`` before anything is written (Req 1.2-1.6).

    Callers invoke this only for new records or when ``parent_id`` changes, so
    edits that keep the parent of a legacy over-deep record are never blocked.
    """
    if new_parent_id is None:
        new_depth=0
    else:
        if not is_new and _is_self_or_ancestor(con,record_id,new_parent_id):
            raise HierarchyError("hierarchy_cycle","不允许形成循环层级")
        new_depth=_depth(con,new_parent_id)
    height=0 if is_new else _height(con,record_id)
    if new_depth+1+height>MAX_DEPTH:
        raise HierarchyError("depth_exceeded","Depth 上限为 %d"%MAX_DEPTH,
                             {"maxDepth":MAX_DEPTH,"resultingDepth":new_depth+1+height})

@contextlib.contextmanager
def tx(path=None):
    """One write transaction: BEGIN IMMEDIATE, COMMIT on success, ROLLBACK on error.

    The connection is always closed (needed to delete temporary databases).
    """
    with _lock:
        con = _connection(path)
        try:
            con.execute("BEGIN IMMEDIATE")
            try:
                yield con
            except BaseException:
                con.rollback()
                raise
            con.commit()
        finally:
            con.close()

def _normalize_save(con, payload, actor, source):
    """Validate a save request and return the normalized plan.

    Same checks, in the same order, as the pre-refactor ``save_record``. ``con``
    is only read, to look up the Section_Rule of the record's placement once the
    database is migrated (``None`` before that = legacy rule).
    """
    if not isinstance(payload,dict):raise ValueError("Record must be an object")
    if any(key in payload for key in MULTI_PARENT_KEYS):raise _multiple_parents()
    record_id=payload.get("id") or "work-"+uuid.uuid4().hex
    if not isinstance(record_id,str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}",record_id):
        raise ValueError("Invalid record ID")
    kind=payload.get("kind")
    title=payload.get("title")
    status=payload.get("status","Planned")
    data=payload.get("data",{})
    department_only=work_hub_sections.department_only_for_placement(
        con,record_id,kind,payload.get("parent_id"))
    raw=_check_record(kind,title,status,data,department_only)
    parent_id=payload.get("parent_id")
    if parent_id is not None and not isinstance(parent_id,str):raise _multiple_parents()
    if parent_id is not None and parent_id==record_id:raise ValueError("Invalid parent")
    if not isinstance(actor,str) or not 1<=len(actor)<=MAX_ACTOR or not isinstance(source,str) or not 1<=len(source)<=500:raise ValueError("Invalid audit metadata")
    expected=payload.get("revision",0)
    if type(expected) is not int or expected<0:raise ValueError("Invalid revision")
    return {"id":record_id,"kind":kind,"title":title,"status":status,"raw":raw,
            "parent_id":parent_id,"expected":expected}

def _apply_fields(con, plan, old, now):
    """INSERT or UPDATE the ``records`` row and return the stored row."""
    created=old["created_at"] if old else now
    archived=old["archived_at"] if old else None
    con.execute("""INSERT INTO records(id,kind,parent_id,title,status,revision,data,created_at,updated_at,archived_at,deleted_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,NULL)
    ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,title=excluded.title,
    status=excluded.status,revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at""",
    (plan["id"],plan["kind"],plan["parent_id"],plan["title"].strip(),plan["status"],
     plan["expected"]+1,plan["raw"],created,now,archived))
    return con.execute("SELECT * FROM records WHERE id=?",(plan["id"],)).fetchone()

def _insert_revision(con, record_id, revision, actor, source, before, after, now, extra=None,
                     before_extra=None):
    """Append exactly one Revision row; ``before``/``after`` are ``records`` rows or None.

    ``extra`` / ``before_extra`` (v2) add keys (``ext`` / ``_change``) to the snapshots.
    """
    snapshot=_serialize(after)
    if extra:snapshot.update(extra)
    previous=_serialize(before) if before else None
    if previous is not None and before_extra:previous.update(before_extra)
    con.execute("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)",
                (uuid.uuid4().hex,record_id,revision,actor,source,
                 json.dumps(previous,ensure_ascii=False) if previous is not None else None,
                 json.dumps(snapshot,ensure_ascii=False),now))

_REMIND_FORMAT="%Y-%m-%dT%H:%M"

def _after_status_change(con, old, after, now, actor=None, source=None):
    """Hook after every successful save/lifecycle step: repeat a Task that just became Done."""
    if after["status"]=="Done" and (old is None or old["status"]!="Done"):
        _create_next_instance(con,old,after,now,actor,source)

def _insert_copy(con, *, title, parent_id, data, tags, repeat_rule, remind_at, actor, source, now,
                 skip_depth, change):
    """Insert one Planned ``task`` copy (record, side tables and Revision #1); returns its id."""
    new_id="work-"+uuid.uuid4().hex
    plan=_normalize_save(con,{"id":new_id,"kind":"task","title":title,"status":"Planned",
                              "parent_id":parent_id,"data":data,"revision":0},actor,source)
    _parent_check(con,parent_id,"task")
    if not skip_depth:_validate_hierarchy(con,new_id,parent_id,is_new=True)
    after=_apply_fields(con,plan,None,now)
    if tags:work_hub_ext.set_tags(con,new_id,tags,now)
    if repeat_rule or remind_at:work_hub_ext.set_ext(con,new_id,remind_at=remind_at,repeat_rule=repeat_rule)
    extra={"_change":change}
    snapshot=work_hub_ext.snapshot(con,new_id)
    if snapshot:extra["ext"]=snapshot
    _insert_revision(con,new_id,1,actor,source,None,after,now,extra)
    return new_id

def _create_next_instance(con, old, after, now, actor, source):
    """Create the next occurrence of a repeating Task that just became Done (design 4.6).

    Runs inside the caller's transaction: any error rolls back the Done write too.
    Returns the new id, or ``None`` (no rule, no usable Due_Date, or a replay).
    """
    if not work_hub_ext.available(con):return None
    record_id=after["id"]
    ext=work_hub_ext.get_ext(con,record_id)
    rule=ext["repeat"]
    if not rule:return None
    source_revision=old["revision"] if old else 0
    if con.execute("SELECT 1 FROM work_recurrences WHERE source_id=? AND source_revision=?",
                   (record_id,source_revision)).fetchone():return None
    data=json.loads(after["data"])
    due=data.get("dueDate") if isinstance(data,dict) else None
    try:
        due_day=date.fromisoformat(due)
        next_day=work_hub_repeat.next_due(rule,due_day)
    except (TypeError,ValueError,OverflowError):
        return None
    remind=None
    if ext["remind_at"]:
        try:
            offset=datetime.strptime(ext["remind_at"],_REMIND_FORMAT)-datetime.combine(due_day,dtime.min)
            remind=(datetime.combine(next_day,dtime.min)+offset).strftime(_REMIND_FORMAT)
        except (ValueError,OverflowError):
            remind=None
    actor=actor or "user"
    marker="recurrence:%s@%d"%(record_id,after["revision"])
    skip_depth=_depth(con,record_id)>MAX_DEPTH
    change={"type":"recurrence-created","sourceId":record_id,"sourceRevision":source_revision}

    def copy_data(row_data,with_due):
        copied={}
        for key in ("description","priority"):
            if isinstance(row_data,dict) and key in row_data:copied[key]=row_data[key]
        if with_due:copied["dueDate"]=next_day.isoformat()
        return copied

    new_id=_insert_copy(con,title=after["title"],parent_id=after["parent_id"],data=copy_data(data,True),
                        tags=work_hub_ext.get_tags(con,record_id),repeat_rule=rule,remind_at=remind,
                        actor=actor,source=marker,now=now,skip_depth=skip_depth,change=change)

    def copy_children(old_parent,new_parent,seen):
        rows=con.execute("""SELECT * FROM records WHERE parent_id=? AND kind IN ('task','action')
                            AND deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at,id""",
                         (old_parent,)).fetchall()
        for child in rows:
            if child["id"] in seen:continue
            seen.add(child["id"])
            child_id=_insert_copy(con,title=child["title"],parent_id=new_parent,
                                  data=copy_data(json.loads(child["data"]),False),
                                  tags=work_hub_ext.get_tags(con,child["id"]),repeat_rule=None,remind_at=None,
                                  actor=actor,source=marker,now=now,skip_depth=skip_depth,change=change)
            copy_children(child["id"],child_id,seen)

    copy_children(record_id,new_id,{record_id})
    con.execute("INSERT INTO work_recurrences(source_id,source_revision,new_id,created_at) VALUES(?,?,?,?)",
                (record_id,source_revision,new_id,now))
    return new_id

def _save_record_tx(con, payload, actor, source, *, now=None, extra=None, before_extra=None):
    """Create/update a record inside an open write transaction.

    ``extra`` / ``before_extra`` (v2 only) are merged into the Revision snapshots.
    """
    plan=_normalize_save(con,payload,actor,source)
    record_id,kind,expected=plan["id"],plan["kind"],plan["expected"]
    old=con.execute("SELECT * FROM records WHERE id=?",(record_id,)).fetchone()
    if old is None and expected!=0:raise Conflict("Record missing or revision mismatch")
    if old is not None and old["revision"]!=expected:raise Conflict("Revision conflict; reload and review differences")
    if old and old["kind"]!=kind:raise ValueError("Record kind cannot change")
    _parent_check(con,plan["parent_id"],kind)
    if old and old["deleted_at"]:raise ValueError("Restore deleted record before editing")
    if old is None or old["parent_id"]!=plan["parent_id"]:
        _validate_hierarchy(con,record_id,plan["parent_id"],is_new=old is None)
    now=now or _now()
    after=_apply_fields(con,plan,old,now)
    if extra or before_extra:
        _insert_revision(con,record_id,expected+1,actor,source,old,after,now,extra,before_extra)
    else:
        _insert_revision(con,record_id,expected+1,actor,source,old,after,now)
    _after_status_change(con,old,after,now,actor=actor,source=source)
    return _serialize(after)

def save_record(payload, actor="manual", source="user", path=None):
    with tx(path) as con:
        return _save_record_tx(con,payload,actor,source)

def _validate_lifecycle(operation, revision):
    if operation not in {"archive","unarchive","delete","restore"}:raise ValueError("Invalid operation")
    if type(revision) is not int:raise ValueError("Invalid revision")

def _lifecycle_tx(con, record_id, revision, operation, actor, source, *, now=None,
                  blocking_children="undeleted", extra=None):
    """archive / unarchive / delete / restore inside an open write transaction.

    ``blocking_children`` decides which children stop a delete: ``"undeleted"``
    (legacy: archived children block too) or ``"active"`` (v2, Req 6.6: only
    children that are neither archived nor deleted).
    """
    _validate_lifecycle(operation,revision)
    row=con.execute("SELECT * FROM records WHERE id=?",(record_id,)).fetchone()
    if row is None:raise NotFound("Record not found")
    if revision!=row["revision"]:raise Conflict("Revision conflict")
    if operation=='restore' and row['parent_id']:
        parent=con.execute('SELECT deleted_at FROM records WHERE id=?',(row['parent_id'],)).fetchone()
        if not parent or parent['deleted_at']:raise ValueError('Restore parent first')
    if operation=="delete":
        archived_clause=" AND archived_at IS NULL" if blocking_children=="active" else ""
        dependent=con.execute("SELECT COUNT(*) FROM records WHERE parent_id=? AND deleted_at IS NULL"+archived_clause,(record_id,)).fetchone()[0]
        if dependent:raise ValueError("Archive or move child records first")
    now=now or _now()
    values={"archive":("archived_at",now),"unarchive":("archived_at",None),
            "delete":("deleted_at",now),"restore":("deleted_at",None)}
    col,value=values[operation]
    con.execute(f"UPDATE records SET {col}=?,revision=revision+1,updated_at=? WHERE id=?",(value,now,record_id))
    after=con.execute("SELECT * FROM records WHERE id=?",(record_id,)).fetchone()
    if extra:
        _insert_revision(con,record_id,revision+1,actor,source,row,after,now,extra)
    else:
        _insert_revision(con,record_id,revision+1,actor,source,row,after,now)
    _after_status_change(con,row,after,now,actor=actor,source=source)
    return _serialize(after)

def set_lifecycle(record_id, revision, operation, actor="manual", source="user",path=None):
    _validate_lifecycle(operation,revision)
    with tx(path) as con:
        return _lifecycle_tx(con,record_id,revision,operation,actor,source)

def link_records(source_id,target_id,relation="related",path=None):
    if source_id==target_id or not re.fullmatch(r"[a-z][a-z0-9_-]{0,39}",relation):raise ValueError("Invalid link")
    with _lock,_connection(path) as con:
        con.execute("BEGIN IMMEDIATE")
        for rid in (source_id,target_id):
            if not con.execute("SELECT 1 FROM records WHERE id=? AND deleted_at IS NULL",(rid,)).fetchone():
                raise NotFound("Linked record missing")
        con.execute("INSERT OR IGNORE INTO links VALUES(?,?,?)",(source_id,target_id,relation))
    return {"source_id":source_id,"target_id":target_id,"relation":relation}

def list_links(record_id, path=None):
    with _lock, _connection(path) as con:
        return [dict(row) for row in con.execute(
            "SELECT source_id,target_id,relation FROM links WHERE source_id=? OR target_id=? ORDER BY relation,target_id",
            (record_id, record_id))]

def unlink_records(source_id, target_id, relation="related", path=None):
    if not isinstance(relation, str) or not re.fullmatch(r"[a-z][a-z0-9_-]{0,39}", relation):
        raise ValueError("Invalid relation")
    with _lock, _connection(path) as con:
        con.execute("BEGIN IMMEDIATE")
        result = con.execute("DELETE FROM links WHERE source_id=? AND target_id=? AND relation=?",
                             (source_id, target_id, relation))
        if not result.rowcount:
            raise NotFound("Link not found")
    return {"source_id": source_id, "target_id": target_id, "relation": relation}

def propose_change(record_id, base_revision, changes, rationale="", evidence="", path=None):
    if type(base_revision) is not int or base_revision < 1:
        raise ValueError("Invalid base revision")
    if not isinstance(changes,dict) or not changes or set(changes)-{"title","status","data","parent_id"}:
        raise ValueError("Invalid proposal fields")
    if not isinstance(rationale,str) or len(rationale)>4000 or not isinstance(evidence,str) or len(evidence)>4000:
        raise ValueError("Invalid explanation")
    raw=json.dumps(changes,ensure_ascii=False,allow_nan=False)
    if len(raw.encode())>MAX_JSON:raise ValueError("Proposal exceeds size limit")
    with _lock, _connection(path) as con:
        con.execute("BEGIN IMMEDIATE")
        row=con.execute("SELECT revision,deleted_at FROM records WHERE id=?",(record_id,)).fetchone()
        if not row:raise NotFound("Record not found")
        if row["deleted_at"]:raise ValueError("Deleted record")
        if row["revision"]!=base_revision:raise Conflict("Proposal based on an outdated revision")
        pid="proposal-"+uuid.uuid4().hex
        con.execute("INSERT INTO proposals VALUES(?,?,?,?,?,?,?,?,?)",
                    (pid,record_id,base_revision,raw,rationale,evidence,"pending",_now(),None))
    return get_proposals(path=path,proposal_id=pid)[0]

def get_proposals(path=None, proposal_id=None):
    with _lock, _connection(path) as con:
        q="SELECT * FROM proposals"
        args=()
        if proposal_id:q+=" WHERE id=?";args=(proposal_id,)
        q+=" ORDER BY created_at DESC"
        return [{**dict(r),"changes":json.loads(r["changes_json"])} for r in con.execute(q,args)]

def review_proposal(proposal_id, decision, path=None):
    if decision not in {"approve","reject"}:raise ValueError("Invalid proposal decision")
    with _lock,_connection(path) as con:
        con.execute("BEGIN IMMEDIATE")
        proposal=con.execute("SELECT * FROM proposals WHERE id=?",(proposal_id,)).fetchone()
        if not proposal:raise NotFound("Proposal not found")
        if proposal["status"]!="pending":raise Conflict("Proposal already reviewed")
        current=con.execute("SELECT * FROM records WHERE id=?",(proposal["record_id"],)).fetchone()
        if not current or current["deleted_at"]:raise Conflict("Target unavailable")
        if current["revision"]!=proposal["base_revision"]:raise Conflict("Target changed; rebase proposal before approval")
        result=None
        if decision=="approve":
            changes=json.loads(proposal["changes_json"])
            data={**_serialize(current),**changes}
            # Approval performs the record mutation inside this same transaction.
            raw=_check_record(current["kind"],data["title"],data["status"],data["data"])
            parent_id=data.get("parent_id")
            _parent_check(con,parent_id,current["kind"])
            now=_now()
            con.execute("""UPDATE records SET parent_id=?,title=?,status=?,data=?,
                         revision=revision+1,updated_at=? WHERE id=?""",
                        (parent_id,data["title"].strip(),data["status"],raw,now,current["id"]))
            after=con.execute("SELECT * FROM records WHERE id=?",(current["id"],)).fetchone()
            con.execute("INSERT INTO revisions VALUES(?,?,?,?,?,?,?,?)",
                (uuid.uuid4().hex,current["id"],after["revision"],"agent-approved",
                 "proposal:"+proposal_id,json.dumps(_serialize(current),ensure_ascii=False),
                 json.dumps(_serialize(after),ensure_ascii=False),now))
            result=_serialize(after)
        con.execute("UPDATE proposals SET status=?,reviewed_at=? WHERE id=?",
                    ("approved" if decision=="approve" else "rejected",_now(),proposal_id))
    return {"proposal_id":proposal_id,"decision":decision,"record":result}

def history(record_id,path=None):
    with _lock,_connection(path) as con:
        return [dict(r) for r in con.execute("SELECT * FROM revisions WHERE record_id=? ORDER BY revision DESC",(record_id,))]
