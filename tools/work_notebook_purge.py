"""Notes permanent deletion: explicit irreversible delete, not Archive.

Only the selected Work Notebook's canonical records and their owned child
metadata are removed, in one SQLite transaction after strict CAS preview.
Linked Events, Tasks, other Pages and shared File Hub files are retained.
"""
from __future__ import annotations

import hashlib
import json

import work_notebook as nb
import work_notebook_v34 as v34
import work_notebook_v35 as v35
import work_hub_nodes as nodes
import work_hub_store as store

PAGE_OWNED_TABLES = (
    "work_note_event_pages", "work_note_page_links", "work_note_page_revisions",
    "work_note_legacy_map",
)
V34_PAGE_TABLES = ("work_note_page_timeline_revisions", "work_note_page_timeline")
V35_PAGE_TABLES = (
    "work_note_v35_file_outbox", "work_note_v35_staging",
    "work_note_v35_refs", "work_note_v35_index_outbox",
    "work_note_v35_index_state", "work_note_v35_history", "work_note_v35_docs",
)
EVENT_OWNED_TABLES = (
    "work_note_event_tasks", "work_note_event_pages", "work_note_event_revisions",
)


def _record(con, kind, target, owner):
    if kind not in ("section", "page", "event") or not isinstance(target, str):
        nb._err("Invalid permanent-delete target", "notebook_delete_invalid")
    nb._node(con, owner)
    table = {
        "section": "work_note_sections",
        "page": "work_note_pages",
        "event": "work_note_events",
    }[kind]
    row = con.execute(f"SELECT * FROM {table} WHERE id=? AND owner_id=?",
                      (target, owner)).fetchone()
    if row is None:
        nb._err("Notes item not found", "notebook_delete_not_found", 404)
    if kind == "section" and row["role"] == "journal" and v34.ready(con):
        nb._err("The fixed Journal / Timeline Section cannot be deleted",
                "notebook_journal_protected", 409)
    return row


def _snapshot(con, kind, row):
    target = row["id"]
    payload = {
        "kind": kind, "targetId": target, "ownerId": row["owner_id"],
        "title": row["title"], "archived": bool(row["archived_at"]),
        "updatedAt": row["updated_at"],
        "revision": row["revision"] if kind != "section" else None,
        "pageCount": 0, "archivedPageCount": 0, "linkedEventCount": 0,
        "attachmentRefs": 0, "legacyPageCount": 0,
    }
    pages = []
    if kind == "section":
        pages = con.execute("SELECT id,owner_id,revision,archived_at,updated_at,legacy_id "
                            "FROM work_note_pages WHERE section_id=? ORDER BY id",
                            (target,)).fetchall()
    elif kind == "page":
        pages = [row]
    if pages:
        ids = [page["id"] for page in pages]
        payload["pageCount"] = len(ids)
        payload["archivedPageCount"] = sum(bool(page["archived_at"]) for page in pages)
        payload["legacyPageCount"] = sum(bool(page["legacy_id"]) for page in pages)
        for pid in ids:
            payload["linkedEventCount"] += con.execute(
                "SELECT count(*) FROM work_note_event_pages WHERE page_id=?", (pid,)).fetchone()[0]
            if v35.ready(con):
                payload["attachmentRefs"] += con.execute(
                    "SELECT count(*) FROM work_note_v35_refs WHERE page_id=?", (pid,)).fetchone()[0]
    elif kind == "event":
        payload["linkedPageCount"] = con.execute(
            "SELECT count(*) FROM work_note_event_pages WHERE event_id=?",
            (target,)).fetchone()[0]
        payload["linkedTaskCount"] = con.execute(
            "SELECT count(*) FROM work_note_event_tasks WHERE event_id=?",
            (target,)).fetchone()[0]
    # Includes all Section Pages (active AND archived), their revisions and
    # lifecycle markers. A concurrent edit/add/archive invalidates confirmation.
    signature_data = {
        "kind": kind, "id": target, "owner": row["owner_id"],
        "title": row["title"], "revision": payload["revision"],
        "updated_at": row["updated_at"], "archived_at": row["archived_at"],
        "pages": [(p["id"], p["revision"], p["archived_at"], p["updated_at"])
                  for p in pages],
        # A legacy Page purge also edits current Work Node data, so the user
        # must reconfirm if that Node changed since the preview.
        "legacyNodeVersions": [
            (owner, con.execute("SELECT revision FROM records WHERE id=?",(owner,)).fetchone()[0])
            for owner in sorted({p["owner_id"] for p in pages if p["legacy_id"]})
        ],
        "eventLinks": [(p["id"], e["event_id"]) for p in pages for e in
                       con.execute("SELECT event_id FROM work_note_event_pages "
                                   "WHERE page_id=? ORDER BY event_id",(p["id"],))],
        "fileRefs": [(p["id"], r["ref_id"], r["file_id"]) for p in pages for r in
                     (con.execute("SELECT ref_id,file_id FROM work_note_v35_refs "
                                  "WHERE page_id=? ORDER BY ref_id",(p["id"],))
                      if v35.ready(con) else [])],
        "eventPageLinks": [e["page_id"] for e in con.execute(
            "SELECT page_id FROM work_note_event_pages WHERE event_id=? ORDER BY page_id",(target,))]
            if kind=="event" else [],
        "eventTaskLinks": [t["task_id"] for t in con.execute(
            "SELECT task_id FROM work_note_event_tasks WHERE event_id=? ORDER BY task_id",(target,))]
            if kind=="event" else [],
    }
    payload["signature"] = hashlib.sha256(json.dumps(
        signature_data, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")).hexdigest()
    return payload


def preview(params, path=None):
    with nodes._reader(path) as con:
        nb._require(con)
        kind, target, owner = params.get("kind"), params.get("targetId"), params.get("id")
        row = _record(con, kind, target, owner)
        return _snapshot(con, kind, row)


def _purge_legacy_source(con, page_id):
    """Remove an explicitly deleted imported Note from the CURRENT Work Node data.

    Keep immutable Work Node revisions for audit; edit no other data fields or
    sibling Notes. This also makes a future idempotent Notes migration check
    consistent after a permanent deletion.
    """
    mapping = con.execute(
        "SELECT owner_id,old_note_id FROM work_note_legacy_map WHERE page_id=?",
        (page_id,)).fetchone()
    if not mapping:
        return
    raw = con.execute("SELECT * FROM records WHERE id=?", (mapping["owner_id"],)).fetchone()
    if not raw:
        nb._err("Legacy Notebook source node is missing", "notebook_delete_integrity", 409)
    record = store._serialize(raw)
    data = record["data"]
    old_id = mapping["old_note_id"]
    changed = False
    entries = data.get("noteEntries")
    if isinstance(entries, list):
        remaining = [entry for entry in entries if not (
            isinstance(entry, dict) and entry.get("id") == old_id)]
        if len(remaining) != len(entries):
            # Remove only the matching legacy source, not sibling Node notes.
            if remaining:
                data["noteEntries"] = remaining
            else:
                data.pop("noteEntries", None)
            changed = True
    elif old_id == "note_legacynote" and isinstance(data.get("notes"), str):
        data.pop("notes", None)
        changed = True
    if changed:
        payload = nodes._payload_for(record, data=data)
        nodes._save(con, payload, "notebook:permanent-delete-legacy-source")


def _purge_page(con, page_id):
    # Detach events instead of deleting independent Event/Milestone records.
    # Delete the active legacy source too, otherwise the older Note can still
    # appear in Work Node data after its canonical Notebook Page is gone.
    _purge_legacy_source(con, page_id)
    for table in PAGE_OWNED_TABLES:
        con.execute(f"DELETE FROM {table} WHERE page_id=?", (page_id,))
    if v34.ready(con):
        for table in V34_PAGE_TABLES:
            con.execute(f"DELETE FROM {table} WHERE page_id=?", (page_id,))
    if v35.ready(con):
        for table in V35_PAGE_TABLES:
            con.execute(f"DELETE FROM {table} WHERE page_id=?", (page_id,))
        con.execute("DELETE FROM work_note_v35_fts WHERE page_id=?", (page_id,))
    con.execute("DELETE FROM work_note_pages WHERE id=?", (page_id,))


def delete(body, path=None):
    """Purge owned Notes data only, atomically with exact-title and snapshot CAS."""
    with nodes._writer(path) as con:
        nb._require(con)
        kind, target, owner = body.get("kind"), body.get("targetId"), body.get("id")
        row = _record(con, kind, target, owner)
        current = _snapshot(con, kind, row)
        if body.get("signature") != current["signature"]:
            nb._err("Notes item or its Pages changed; refresh the delete preview",
                    "notebook_delete_conflict", 409)
        if body.get("confirm") != "DELETE PERMANENTLY" or body.get("confirmTitle") != row["title"]:
            nb._err("Type the exact title to confirm permanent deletion",
                    "notebook_delete_confirmation", 400)
        if kind == "section":
            page_ids = [r["id"] for r in con.execute(
                "SELECT id FROM work_note_pages WHERE section_id=? ORDER BY id",
                (target,))]
            for page_id in page_ids:
                _purge_page(con, page_id)
            if v34.ready(con):
                con.execute("DELETE FROM work_note_section_action_audit WHERE section_id=?",
                            (target,))
            con.execute("DELETE FROM work_note_sections WHERE id=?", (target,))
        elif kind == "page":
            _purge_page(con, target)
        else:
            for table in EVENT_OWNED_TABLES:
                con.execute(f"DELETE FROM {table} WHERE event_id=?", (target,))
            con.execute("DELETE FROM work_note_events WHERE id=?", (target,))
        # PRAGMA foreign_key_check is read-only and catches accidental dangling
        # metadata immediately, before the transaction commits.
        if con.execute("PRAGMA foreign_key_check").fetchone():
            nb._err("Permanent deletion left a linked record; transaction rolled back",
                    "notebook_delete_integrity", 409)
        return {
            "deleted": True, "kind": kind, "targetId": target,
            "deletedPages": current["pageCount"] if kind != "event" else 0,
            "detachedEventLinks": current["linkedEventCount"],
            "filesPreserved": True,
        }
