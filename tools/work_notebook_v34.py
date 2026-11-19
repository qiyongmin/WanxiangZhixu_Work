"""KB_Work Notes V3.4 — additive Journal/Timeline model.

All reads are read-only. migrate() is explicit and requires an independently
verified Work-only backup. No legacy Page/Event IDs or history are rewritten.
"""
from __future__ import annotations

import datetime as dt
import json
import uuid

import work_notebook as nb
import work_hub_nodes as nodes

STATUS_KEY = "notebook_v34_ready"
JOURNAL_TITLE = "Journal / Timeline"
DDL = (
    """CREATE TABLE IF NOT EXISTS work_note_page_timeline (
      page_id TEXT PRIMARY KEY REFERENCES work_note_pages(id),
      timeline_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS work_note_page_timeline_date ON work_note_page_timeline(timeline_date,page_id)",
    """CREATE TABLE IF NOT EXISTS work_note_page_timeline_revisions (
      page_id TEXT NOT NULL REFERENCES work_note_pages(id),
      page_revision INTEGER NOT NULL, timeline_date TEXT, source TEXT NOT NULL,
      occurred_at TEXT NOT NULL, PRIMARY KEY(page_id,page_revision))""",
    """CREATE TABLE IF NOT EXISTS work_note_section_action_audit (
      id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES work_note_sections(id),
      action TEXT NOT NULL, expected_updated_at TEXT,
      occurred_at TEXT NOT NULL, details_json TEXT NOT NULL)""",
)

def ready(con):
    return con.execute("SELECT 1 FROM work_meta WHERE key=?", (STATUS_KEY,)).fetchone() is not None

def _require(con):
    nb._require(con)
    if not ready(con):
        nb._err("Notes V3.4 migration required", "notebook_v34_migration_required", 409)

def date(value, *, nullable=False):
    if nullable and value is None:
        return None
    if not isinstance(value, str) or not nb.DAY.fullmatch(value):
        nb._err("Timeline Date must be YYYY-MM-DD", "notebook_date_invalid")
    try:
        return dt.date.fromisoformat(value).isoformat()
    except ValueError:
        nb._err("Invalid calendar date", "notebook_date_invalid")

def _today():
    return dt.date.today().isoformat()

def _active_journal(con, owner):
    return con.execute("SELECT * FROM work_note_sections WHERE owner_id=? AND role='journal' "
                       "AND archived_at IS NULL", (owner,)).fetchone()

def ensure_journal(con, owner):
    """Only call within a write transaction after V3.4 was enabled."""
    if not ready(con):
        return None
    found = con.execute("SELECT * FROM work_note_sections WHERE owner_id=? AND role='journal'",
                        (owner,)).fetchone()
    if found:
        if found["archived_at"] or found["title"] != JOURNAL_TITLE:
            con.execute("UPDATE work_note_sections SET title=?,archived_at=NULL,updated_at=? WHERE id=?",
                        (JOURNAL_TITLE, nb._stamp(), found["id"]))
        return found["id"]
    return nb._section_create(con, owner, JOURNAL_TITLE, "journal", migrating=True)["id"]

def _valid_date_from_timestamp(timestamp):
    if not isinstance(timestamp, str) or len(timestamp) < 10:
        return None
    try:
        return date(timestamp[:10])
    except nodes.NodeError:
        return None

def _event_ids(con, page_id):
    return [r["event_id"] for r in con.execute(
        "SELECT l.event_id FROM work_note_event_pages l JOIN work_note_events e "
        "ON e.id=l.event_id WHERE l.page_id=? AND e.archived_at IS NULL ORDER BY l.event_id",
        (page_id,))]

def paired_event(con, page):
    """Only unambiguous, active, one-to-one Journal Page/Event relations qualify."""
    if not page or page["archived_at"]:
        return None
    section = con.execute("SELECT role,archived_at FROM work_note_sections WHERE id=?",
                          (page["section_id"],)).fetchone()
    if not section or section["role"] != "journal" or section["archived_at"]:
        return None
    ids = _event_ids(con, page["id"])
    if len(ids) != 1:
        return None
    candidate = con.execute("SELECT * FROM work_note_events WHERE id=? AND archived_at IS NULL",
                            (ids[0],)).fetchone()
    if not candidate:
        return None
    pages = [r["page_id"] for r in con.execute(
        "SELECT page_id FROM work_note_event_pages WHERE event_id=?", (candidate["id"],))]
    if len(pages) != 1 or pages[0] != page["id"]:
        return None
    nb._same_root(con, page["owner_id"], candidate["owner_id"])
    return candidate

def _date_get(con, page_id):
    record = con.execute("SELECT timeline_date FROM work_note_page_timeline WHERE page_id=?",
                         (page_id,)).fetchone()
    return record["timeline_date"] if record else None

def _date_put(con, page_id, day, page_revision, source, *, stamp=None):
    stamp = stamp or nb._stamp()
    con.execute("INSERT INTO work_note_page_timeline (page_id,timeline_date,created_at,updated_at)"
                " VALUES(?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET "
                "timeline_date=excluded.timeline_date,updated_at=excluded.updated_at",
                (page_id, day, stamp, stamp))
    con.execute("INSERT INTO work_note_page_timeline_revisions "
                "(page_id,page_revision,timeline_date,source,occurred_at) VALUES(?,?,?,?,?)",
                (page_id, page_revision, day, source, stamp))

def ensure_page_date(con, page_id, preferred=None):
    if not ready(con):
        return
    pg = nb._page(con, page_id, active=False)
    section = con.execute("SELECT role FROM work_note_sections WHERE id=?",
                          (pg["section_id"],)).fetchone()
    if not section or section["role"] != "journal" or con.execute(
        "SELECT 1 FROM work_note_page_timeline WHERE page_id=?", (page_id,)).fetchone():
        return
    partner = paired_event(con, pg)
    default = preferred if preferred is not None else (
        partner["event_date"] if partner else _valid_date_from_timestamp(pg["created_at"]))
    if default is None:
        default = _today() if preferred is not None else None
    _date_put(con, page_id, date(default, nullable=True), pg["revision"], "notebook:v34-initial")

def migrate(path=None):
    """Idempotent and transaction-safe; caller must verify a Work-only backup first."""
    with nodes._writer(path) as con:
        nb._require(con)
        if ready(con):
            return {"ready": True, "changed": False,
                    "journals": con.execute("SELECT count(*) FROM work_note_sections WHERE role='journal' AND archived_at IS NULL").fetchone()[0],
                    "datedPages": con.execute("SELECT count(*) FROM work_note_page_timeline").fetchone()[0]}
        for ddl in DDL:
            con.execute(ddl)
        index = nodes._Index(con)
        owners = [r["id"] for r in con.execute(
            "SELECT id FROM records WHERE kind IN "
            "('initiative','knowledge_collection','topic','workstream','campaign','task','action') "
            "AND archived_at IS NULL AND deleted_at IS NULL ORDER BY id")]
        count = 0
        for owner in owners:
            try:
                chain = index.chain(owner)
                if not chain or len(chain) > 4 or any(index.rows[x]["archived_at"] or
                        index.rows[x]["deleted_at"] for x in chain):
                    continue
            except (KeyError, ValueError):
                continue
            # Before STATUS_KEY is set, ensure_journal() is deliberately disabled.
            existing = con.execute(
                "SELECT id,archived_at,title FROM work_note_sections WHERE owner_id=? AND role='journal'",
                (owner,)).fetchone()
            if existing:
                if existing["archived_at"] or existing["title"] != JOURNAL_TITLE:
                    con.execute("UPDATE work_note_sections SET title=?,archived_at=NULL,updated_at=? WHERE id=?",
                                (JOURNAL_TITLE, nb._stamp(), existing["id"]))
            else:
                nb._section_create(con, owner, JOURNAL_TITLE, "journal", migrating=True)
            count += 1
        pages = con.execute(
            "SELECT p.* FROM work_note_pages p JOIN work_note_sections s ON s.id=p.section_id "
            "WHERE s.role='journal' ORDER BY p.id").fetchall()
        for pg in pages:
            partner = paired_event(con, pg)
            d = partner["event_date"] if partner else _valid_date_from_timestamp(pg["created_at"])
            _date_put(con, pg["id"], date(d, nullable=True), pg["revision"], "notebook:v34-migration")
        now = nb._stamp()
        con.execute("INSERT INTO work_meta(key,value,updated_at) VALUES(?,?,?)",
                    (STATUS_KEY, "1", now))
        return {"ready": True, "changed": True, "journals": count, "datedPages": len(pages)}

def sections_view(params, path=None):
    with nodes._reader(path) as con:
        _require(con)
        owner = params.get("id")
        nb._node(con, owner)
        archived = str(params.get("archived") or "").lower() in ("1", "true")
        archived_clause = "IS NOT NULL" if archived else "IS NULL"
        sections = [dict(row) for row in con.execute(
            "SELECT * FROM work_note_sections WHERE owner_id=? AND archived_at " +
            archived_clause + " ORDER BY CASE WHEN role='journal' THEN 0 ELSE 1 END, position,id",
            (owner,))]
        counts = {r["section_id"]: r["count"] for r in con.execute(
            "SELECT section_id,count(*) AS count FROM work_note_pages WHERE owner_id=? "
            "AND archived_at IS NULL GROUP BY section_id", (owner,))}
        for s in sections:
            s["pageCount"] = counts.get(s["id"], 0)
        refs = [dict(row) for row in con.execute(
            "SELECT p.id,p.title,p.owner_id,p.section_id,l.target_node_id "
            "FROM work_note_page_links l JOIN work_note_pages p ON p.id=l.page_id "
            "JOIN work_note_sections s ON s.id=p.section_id "
            "WHERE l.target_node_id=? AND p.archived_at IS NULL AND s.archived_at IS NULL "
            "ORDER BY p.updated_at DESC LIMIT 100", (owner,))]
        return {"sections": sections, "linkedPages": refs}

def pages_view(params, path=None):
    with nodes._reader(path) as con:
        _require(con)
        owner = params.get("id")
        nb._node(con, owner)
        section = params.get("section") or ""
        if isinstance(section, list):
            section = section[0] if section else ""
        if section:
            nb._section(con, owner, section)
        archived = str(params.get("archived") or "").lower() in ("1", "true")
        limit = nb._int(params.get("limit", 40), 40, 100)
        offset = nb._int(params.get("offset", 0), 0, 1000000)
        q = (params.get("q") or "").strip()
        if len(q) > 200:
            nb._err("Search too long")
        condition = "IS NOT NULL" if archived else "IS NULL"
        args = [owner]
        where = "p.owner_id=? AND p.archived_at " + condition + " AND s.archived_at IS NULL"
        if section:
            where += " AND p.section_id=?"
            args.append(section)
        if q:
            where += " AND (p.title LIKE ? OR p.html LIKE ?)"
            args.extend(["%" + q + "%"] * 2)
        join = " FROM work_note_pages p JOIN work_note_sections s ON s.id=p.section_id "
        total = con.execute("SELECT count(*)" + join + "WHERE " + where, args).fetchone()[0]
        rows = [dict(row) for row in con.execute(
            "SELECT p.id,p.owner_id,p.section_id,p.title,p.position,p.revision,p.created_at,"
            "p.updated_at,p.legacy_id,t.timeline_date AS timelineDate" +
            join + "LEFT JOIN work_note_page_timeline t ON t.page_id=p.id "
            "WHERE " + where + " ORDER BY p.position,p.id LIMIT ? OFFSET ?",
            (*args, limit, offset))]
        return {"items": rows, "total": total, "limit": limit, "offset": offset}

def archive_section(body, path=None):
    with nodes._writer(path) as con:
        _require(con)
        owner, sid = body.get("id"), body.get("sectionId")
        nb._node(con, owner)
        sec = con.execute("SELECT * FROM work_note_sections WHERE id=? AND owner_id=?",
                          (sid, owner)).fetchone()
        if not sec:
            nb._err("Section not found", "notebook_section_not_found", 404)
        if sec["role"] == "journal":
            nb._err("The Journal / Timeline Section is protected", "notebook_journal_protected", 409)
        expected = body.get("expectedUpdatedAt")
        if not isinstance(expected, str) or expected != sec["updated_at"]:
            nb._err("Section changed; reload before archiving/restoring", "notebook_conflict", 409,
                    currentUpdatedAt=sec["updated_at"])
        op = body.get("action")
        if op == "notebook-section-archive":
            if sec["archived_at"]:
                nb._err("Section already archived", "notebook_invalid_state", 409)
            new_archive = nb._stamp()
        elif op == "notebook-section-restore":
            if not sec["archived_at"]:
                nb._err("Section is not archived", "notebook_invalid_state", 409)
            new_archive = None
        else:
            nb._err("Unknown Section action")
        now = nb._stamp()
        count = con.execute("SELECT count(*) FROM work_note_pages WHERE section_id=? "
                            "AND archived_at IS NULL", (sid,)).fetchone()[0]
        con.execute("UPDATE work_note_sections SET archived_at=?,updated_at=? WHERE id=?",
                    (new_archive, now, sid))
        con.execute("INSERT INTO work_note_section_action_audit VALUES(?,?,?,?,?,?)",
                    ("nsa_"+uuid.uuid4().hex, sid, op, expected, now,
                     json.dumps({"owner": owner, "activePages": count}, sort_keys=True)))
        return {"changed": True, "sectionId": sid, "activePages": count,
                "updatedAt": now, "archived": new_archive is not None}

def _source_path(index, owner):
    path = index.chain(owner)
    return [{"id": pid, "title": index.rows[pid]["title"],
             "level": min(len(index.chain(pid)), 4)} for pid in path]

def _entry_for_page(page, index, d):
    return {"key": "page:"+page["id"], "type": "page", "pageId": page["id"],
            "pageOwnerId": page["owner_id"], "pageSectionId": page["section_id"],
            "pageRevision": page["revision"], "date": d, "title": page["title"],
            "kind": "journal", "sourcePath": _source_path(index, page["owner_id"]),
            "eventTime": None, "eventId": None, "eventRevision": None,
            "linkedPageIds": [], "linkedTaskIds": []}

def timeline_view(params, path=None):
    """Unified indexed query, paired only on a unique bidirectional 1:1 edge."""
    with nodes._reader(path) as con:
        _require(con)
        owner = params.get("id")
        _, root = nb._node(con, owner)
        index = nodes._Index(con)
        members = [identifier for identifier, row in index.rows.items()
                   if index.is_tree(row) and not row["deleted_at"] and not row["archived_at"]
                   and index.top(identifier) == root and len(index.chain(identifier)) <= 4]
        selected_source = params.get("source") or ""
        if selected_source and selected_source not in members:
            nb._err("Timeline source is outside this project", "notebook_cross_root")
        if selected_source:
            members = [selected_source]
        if not members:
            return {"items": [], "total": 0, "rootId": root, "limit": 40, "offset": 0}
        placeholders = ",".join("?" for _ in members)
        archived = str(params.get("archived") or "").lower() in ("1","true")
        lifecycle_clause = "IS NOT NULL" if archived else "IS NULL"
        events = con.execute("SELECT * FROM work_note_events WHERE archived_at " +
                             lifecycle_clause + " AND owner_id IN ("+placeholders+")",members).fetchall()
        pages = [] if archived else con.execute(
            "SELECT p.*,t.timeline_date FROM work_note_pages p "
            "JOIN work_note_sections s ON s.id=p.section_id AND s.role='journal' "
            "LEFT JOIN work_note_page_timeline t ON t.page_id=p.id "
            "WHERE p.archived_at IS NULL AND s.archived_at IS NULL AND p.owner_id IN ("+
            placeholders+")", members).fetchall()
        pages_by_id = {row["id"]: row for row in pages}
        edges = con.execute("SELECT l.event_id,l.page_id FROM work_note_event_pages l "
                            "JOIN work_note_events e ON e.id=l.event_id AND e.archived_at " + lifecycle_clause + " "
                            "WHERE e.owner_id IN ("+placeholders+")", members).fetchall()
        by_event, by_page = {}, {}
        for edge in edges:
            by_event.setdefault(edge["event_id"], []).append(edge["page_id"])
            by_page.setdefault(edge["page_id"], []).append(edge["event_id"])
        tasks = {}
        for row in con.execute("SELECT event_id,task_id FROM work_note_event_tasks WHERE "
                               "event_id IN (SELECT id FROM work_note_events WHERE "
                               "owner_id IN ("+placeholders+") AND archived_at " + lifecycle_clause + ")", members):
            tasks.setdefault(row["event_id"], []).append(row["task_id"])
        entries = []
        paired = set()
        for ev in events:
            page_ids = by_event.get(ev["id"], [])
            candidate = (pages_by_id.get(page_ids[0]) if len(page_ids) == 1 and
                         len(by_page.get(page_ids[0], [])) == 1 else None)
            # Cardinality must be checked against the FULL L1 graph, not just
            # the currently filtered Source Level. Otherwise source filtering
            # can incorrectly turn a multi-linked Page into a false pair.
            verified = paired_event(con, candidate) if candidate else None
            pair = candidate if verified and verified["id"] == ev["id"] else None
            if pair:
                paired.add(pair["id"])
                item = _entry_for_page(pair, index, pair["timeline_date"] or ev["event_date"])
                item.update(key="paired:"+ev["id"], type="paired", eventId=ev["id"],
                            eventOwnerId=ev["owner_id"], eventRevision=ev["revision"],
                            kind=ev["kind"], eventTime=ev["event_time"],
                            linkedPageIds=page_ids, linkedTaskIds=tasks.get(ev["id"], []))
            else:
                item = {"key": "event:"+ev["id"], "type": "event", "eventId": ev["id"],
                        "eventOwnerId": ev["owner_id"], "eventRevision": ev["revision"],
                        "pageId": None, "pageOwnerId": None, "pageRevision": None,
                        "date": ev["event_date"], "eventTime": ev["event_time"],
                        "title": ev["title"], "kind": ev["kind"],
                        "sourcePath": _source_path(index, ev["owner_id"]),
                        "linkedPageIds": page_ids, "linkedTaskIds": tasks.get(ev["id"], [])}
            entries.append(item)
        for pg in pages:
            if pg["id"] not in paired:
                entries.append(_entry_for_page(pg, index, pg["timeline_date"]))
        kind = params.get("kind") or ""
        if kind and kind not in nb.TYPES:
            nb._err("Invalid Event type")
        query = (params.get("q") or "").strip().casefold()
        if len(query) > 200:
            nb._err("Search too long")
        start, end = params.get("from") or "", params.get("to") or ""
        if start: start = date(start)
        if end: end = date(end)
        entries = [item for item in entries
                   if (not kind or item["kind"] == kind) and
                   (not query or query in item["title"].casefold()) and
                   (not start or (item["date"] and item["date"] >= start)) and
                   (not end or (item["date"] and item["date"] <= end))]
        entries.sort(key=lambda it: (it["date"] is not None, it["date"] or "",
                                      it["eventTime"] or "", it["key"]), reverse=True)
        limit = nb._int(params.get("limit", 40), 40, 100)
        offset = nb._int(params.get("offset", 0), 0, 1000000)
        return {"items": entries[offset:offset+limit], "total": len(entries),
                "rootId": root, "limit": limit, "offset": offset}

def timeline_date_set(body, path=None):
    with nodes._writer(path) as con:
        _require(con)
        pg = nb._page(con, body.get("pageId") or "")
        nb._node(con, pg["owner_id"])
        section = nb._section(con, pg["owner_id"], pg["section_id"])
        if section["role"] != "journal":
            nb._err("Only Journal Pages have Timeline Date", "notebook_invalid_section")
        expected = body.get("baseRevision")
        if type(expected) is not int or expected != pg["revision"]:
            nb._err("Page Revision conflict", "revision_conflict", 409,
                    currentRevision=pg["revision"])
        day = date(body.get("timelineDate"))
        ev = paired_event(con, pg)
        if ev:
            if body.get("linkedEventId") != ev["id"] or type(body.get("eventBaseRevision")) is not int or (
                    body["eventBaseRevision"] != ev["revision"]):
                nb._err("Linked Event Revision conflict", "revision_conflict", 409,
                        currentRevision=ev["revision"])
            nb._event_stamp(day, ev["event_time"], ev["timezone"])
        elif body.get("linkedEventId"):
            nb._err("Linked Event relationship changed", "notebook_conflict", 409)
        before = _date_get(con, pg["id"])
        if before == day and (not ev or ev["event_date"] == day):
            return {"changed": False, "page": nb._page_detail(con, pg),
                    "event": nb._event_detail(con, ev) if ev else None}
        stamp = nb._stamp()
        nextrev = pg["revision"] + 1
        con.execute("UPDATE work_note_pages SET revision=?,updated_at=? WHERE id=?",
                    (nextrev, stamp, pg["id"]))
        con.execute("INSERT INTO work_note_page_revisions VALUES(?,?,?,?,?,?,?)",
                    (pg["id"], nextrev, pg["title"], pg["html"], "user",
                     "notebook:timeline-date-set", stamp))
        _date_put(con, pg["id"], day, nextrev, "notebook:timeline-date-set", stamp=stamp)
        changed_event = None
        if ev:
            _, time, tz, instant = nb._event_stamp(day, ev["event_time"], ev["timezone"])
            con.execute("UPDATE work_note_events SET event_date=?,event_time=?,timezone=?,"
                        "instant_utc=?,revision=revision+1,updated_at=? WHERE id=?",
                        (day, time, tz, instant, stamp, ev["id"]))
            changed_event = nb._event(con, ev["id"])
            nb._event_revision(con, changed_event)
        return {"changed": True, "page": nb._page_detail(con, nb._page(con, pg["id"])),
                "event": nb._event_detail(con, changed_event) if changed_event else None}

def sync_event_date(con, old_event, new_day, body):
    """Invoked by existing Event save inside SAME transaction after Event CAS."""
    if not ready(con) or old_event["event_date"] == new_day:
        return
    links = [r["page_id"] for r in con.execute(
        "SELECT page_id FROM work_note_event_pages WHERE event_id=?",
        (old_event["id"],))]
    if len(links) != 1:
        return
    pg = nb._page(con, links[0], active=False)
    match = paired_event(con, pg)
    if not match or match["id"] != old_event["id"]:
        return
    if type(body.get("pageBaseRevision")) is not int or body["pageBaseRevision"] != pg["revision"]:
        nb._err("Linked Page Revision conflict", "revision_conflict", 409,
                currentRevision=pg["revision"])
    stamp = nb._stamp()
    rev = pg["revision"] + 1
    con.execute("UPDATE work_note_pages SET revision=?,updated_at=? WHERE id=?",
                (rev, stamp, pg["id"]))
    con.execute("INSERT INTO work_note_page_revisions VALUES(?,?,?,?,?,?,?)",
                (pg["id"], rev, pg["title"], pg["html"], "user", "notebook:event-date-sync", stamp))
    _date_put(con, pg["id"], new_day, rev, "notebook:event-date-sync", stamp=stamp)


def page_view(params, path=None):
    """Owner-scoped original Page, including recoverable archived deep links."""
    with nodes._reader(path) as con:
        _require(con)
        owner = params.get("id")
        nb._node(con, owner)
        pid = params.get("page") or ""
        if not pid and params.get("note"):
            old = con.execute("SELECT page_id FROM work_note_legacy_map WHERE owner_id=? "
                              "AND old_note_id=?", (owner, params["note"])).fetchone()
            pid = old["page_id"] if old else ""
        page = nb._page(con, pid, active=False)
        if page["owner_id"] != owner:
            nb._err("Page does not belong to this Notebook", "notebook_owner_mismatch", 403)
        section = con.execute("SELECT id,title,updated_at,archived_at FROM work_note_sections "
                              "WHERE id=? AND owner_id=?", (page["section_id"], owner)).fetchone()
        result = nb._page_detail(con, page)
        result["pageArchived"] = bool(page["archived_at"])
        result["sectionArchived"] = bool(section and section["archived_at"])
        result["sectionUpdatedAt"] = section["updated_at"] if section else None
        return result


def event_view(params, path=None):
    """Legacy Event ID remains resolvable after soft archive."""
    with nodes._reader(path) as con:
        _require(con)
        owner = params.get("id")
        nb._node(con, owner)
        event = con.execute("SELECT * FROM work_note_events WHERE id=?",
                            (params.get("event") or "",)).fetchone()
        if not event:
            nb._err("Event not found", "notebook_event_not_found", 404)
        nb._same_root(con, owner, event["owner_id"])
        result = nb._event_detail(con, event)
        result["archivedAt"] = event["archived_at"]
        return result


def restore_event(body, path=None):
    with nodes._writer(path) as con:
        _require(con)
        event = con.execute("SELECT * FROM work_note_events WHERE id=?",
                            (body.get("eventId") or "",)).fetchone()
        if not event:
            nb._err("Event not found", "notebook_event_not_found", 404)
        nb._node(con, event["owner_id"])
        if not event["archived_at"]:
            nb._err("Event is not archived", "notebook_invalid_state", 409)
        rev = body.get("baseRevision")
        if type(rev) is not int or rev != event["revision"]:
            nb._err("Event Revision conflict", "revision_conflict", 409,
                    currentRevision=event["revision"])
        con.execute("UPDATE work_note_events SET archived_at=NULL,revision=revision+1,"
                    "updated_at=? WHERE id=?", (nb._stamp(), event["id"]))
        restored = nb._event(con, event["id"])
        nb._event_revision(con, restored)
        return {"event": nb._event_detail(con, restored), "changed": True}


def main(argv=None):
    """Explicit operator migration on an existing Work DB after backup verification."""
    import argparse
    import hashlib
    from pathlib import Path
    import sqlite3
    import work_backup
    parser = argparse.ArgumentParser(description="Notes V3.4 additive Work-only migration")
    parser.add_argument("--db", type=Path, required=True,
                        help="Existing standalone KB_Work work.sqlite3; never a personal-site DB")
    parser.add_argument("--verified-backup", type=Path, required=True,
                        help="An independently created Work backup to verify before writing")
    args = parser.parse_args(argv)
    db = args.db.expanduser().resolve()
    backup = args.verified_backup.expanduser().resolve()
    if db.name != "work.sqlite3" or not db.is_file() or not backup.is_file() or (
        "KB_Site" in str(db) or "KB_Site" in str(backup)):
        parser.error("Refusing non-Work database/backup or missing verified inputs")
    verified = work_backup.verify(backup)
    if not verified["verified"] or not verified["workOnly"]:
        parser.error("Work-only backup verification failed")
    def unchanged_snapshot(con):
        hash_ = hashlib.sha256()
        counts = {}
        for table, columns in (
            ("records", "id,revision,data"),
            ("revisions", "*"),
            ("work_note_pages", "id,owner_id,section_id,title,html,revision,legacy_id,created_at,updated_at,archived_at"),
            ("work_note_page_revisions", "*"),
            ("work_note_events", "*"),
            ("work_note_event_revisions", "*"),
            ("work_note_event_pages", "*"),
            ("work_note_event_tasks", "*"),
            ("work_note_legacy_map", "*"),
            ("work_note_page_links", "*"),
        ):
            rows = [list(row) for row in con.execute("SELECT " + columns + " FROM " + table + " ORDER BY 1")]
            counts[table] = len(rows)
            hash_.update(json.dumps([table, rows], ensure_ascii=False, default=str).encode())
        return counts, hash_.hexdigest()
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as ro:
        before, before_hash = unchanged_snapshot(ro)
    migrated = migrate(path=db)
    twice = migrate(path=db)
    if twice["changed"]:
        raise RuntimeError("Notes V3.4 migration not idempotent")
    with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as ro:
        after, after_hash = unchanged_snapshot(ro)
        integrity = ro.execute("PRAGMA integrity_check").fetchone()[0]
        foreign_key_errors = ro.execute("PRAGMA foreign_key_check").fetchall()
        versions = ro.execute("SELECT value FROM work_meta WHERE key=?", (STATUS_KEY,)).fetchone()
    if before != after or before_hash != after_hash or integrity != "ok" or foreign_key_errors or not versions:
        raise RuntimeError("Notes migration preservation/integrity check failed")
    print(json.dumps({"backupVerified": True, "changed": migrated["changed"],
                      "idempotent": True, "journals": migrated["journals"],
                      "datedPages": migrated["datedPages"], "canonicalPreserved": True,
                      "canonicalCounts": after, "sqliteIntegrity": integrity,
                      "foreignKeyCheck": "ok"}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
