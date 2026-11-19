"""Materials V3.0: stable, local L1-owned canonical storage.

No arbitrary paths from browsers. Each mapping binds a Work L1 ID to one
validated File Hub folder. Existing files are never moved by this module.
"""
from __future__ import annotations
import re
import sqlite3
import unicodedata
from pathlib import Path

import file_hub
import work_hub_store as store

KINDS = ("initiative", "topic", "knowledge_collection")


def _slug(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value)
    clean = re.sub(r"[^a-zA-Z0-9-]+", "-", normalized).strip("-").lower()
    return (clean[:44] or "work")


def _schema(con):
    con.execute("""CREATE TABLE IF NOT EXISTS material_storage_l1(
        l1_id TEXT PRIMARY KEY REFERENCES records(id),
        folder TEXT NOT NULL UNIQUE,
        origin TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)""")


def _owner(con, node_id: str):
    if not isinstance(node_id, str) or not re.fullmatch(r"[\w:.-]{1,120}", node_id):
        raise ValueError("Invalid Work Node ID")
    seen = set()
    row = con.execute("SELECT id,title,kind,parent_id,deleted_at FROM records WHERE id=?", (node_id,)).fetchone()
    if row is None or row["deleted_at"]:
        raise ValueError("Work item not found or removed")
    while row["parent_id"] is not None:
        if row["id"] in seen:
            raise ValueError("Invalid Work hierarchy")
        seen.add(row["id"])
        row = con.execute("SELECT id,title,kind,parent_id,deleted_at FROM records WHERE id=?",
                          (row["parent_id"],)).fetchone()
        if row is None or row["deleted_at"]:
            raise ValueError("Work parent is missing or removed")
    if row["kind"] not in KINDS:
        raise ValueError("Work item is not under an L1")
    return row


def _safe_folder(folder: str, library: Path):
    if not isinstance(folder, str) or not folder.startswith("Projects/"):
        raise ValueError("Materials folder must be inside Projects")
    parts = folder.split("/")
    if any(not p or p in (".", "..") or p.startswith(".") or ":" in p or "\\" in p for p in parts):
        raise ValueError("Unsafe Materials directory")
    current = library.resolve()
    for segment in parts:
        current = current / segment
        if current.is_symlink():
            raise ValueError("Symlink Materials directory forbidden")
    if not current.resolve().is_relative_to(library.resolve()):
        raise ValueError("Storage directory is outside File Hub")
    return current


def _candidate(con, l1, library: Path):
    """Reuse an existing dedicated root only with an actual file-link proof.

    We never assume a similarly named folder belongs to an L1 merely by name.
    """
    candidates = [f"Projects/{_slug(l1['title'])}",
                  f"Projects/WorkHub/{_slug(l1['title'])}"]
    # Historical workspace folder naming is only a candidate.
    candidates += [f"Projects/{re.sub('[^A-Za-z0-9]', '', l1['title'])}",
                   f"Projects/WorkHub/{re.sub('[^A-Za-z0-9]', '', l1['title'])}"]
    ids = []
    for row in con.execute("""WITH RECURSIVE subtree(id) AS (
          SELECT id FROM records WHERE id=?
          UNION ALL SELECT r.id FROM records r JOIN subtree s ON r.parent_id=s.id
          WHERE r.deleted_at IS NULL
        ) SELECT m.data FROM links l
          JOIN subtree s ON l.source_id=s.id JOIN records m ON m.id=l.target_id
          WHERE m.kind='material' AND m.deleted_at IS NULL""", (l1["id"],)):
        try:
            import json
            fid = json.loads(row[0]).get("fileId")
            if isinstance(fid, str):
                ids.append(fid)
        except (ValueError, TypeError, AttributeError):
            continue
    if not ids:
        return None
    with file_hub._db() as hub:
        for rel in dict.fromkeys(candidates):
            if not rel or rel.endswith("/"):
                continue
            base = _safe_folder(rel, library)
            if not base.is_dir():
                continue
            matching = 0
            for fid in ids:
                item = hub.execute("SELECT path FROM files WHERE id=? AND deleted=0", (fid,)).fetchone()
                if item and item["path"].startswith(rel + "/"):
                    matching += 1
            if matching:
                return rel + "/Materials"
    return None


def get_for_node(node_id: str, db_path=None, library=None):
    """Read-only lookup. Pending means no dedicated mapping has been provisioned."""
    library = Path(library or file_hub.LIBRARY)
    with store._lock, store._connection(db_path) as con:
        _schema(con)
        l1 = _owner(con, node_id)
        row = con.execute("SELECT folder,origin FROM material_storage_l1 WHERE l1_id=?",
                          (l1["id"],)).fetchone()
        return {"l1Id": l1["id"], "l1Title": l1["title"],
                "folder": row["folder"] if row else None,
                "origin": row["origin"] if row else "pending",
                "ready": bool(row and _safe_folder(row["folder"], library).is_dir())}


def ensure_for_node(node_id: str, db_path=None, library=None):
    """Idempotent provisioning. No existing file is moved, deleted, or overwritten."""
    library = Path(library or file_hub.LIBRARY)
    with store._lock, store._connection(db_path) as con:
        _schema(con)
        l1 = _owner(con, node_id)
        row = con.execute("SELECT folder,origin FROM material_storage_l1 WHERE l1_id=?",
                          (l1["id"],)).fetchone()
        if row:
            folder, origin = row["folder"], row["origin"]
        else:
            verified = _candidate(con, l1, library)
            if verified:
                folder, origin = verified, "verified-existing"
            else:
                folder = f"Projects/WorkHub/L1/{_slug(l1['title'])}--{_slug(l1['id'])}/Materials"
                origin = "auto-created"
        dst = _safe_folder(folder, library)
        dst.mkdir(parents=True, exist_ok=True)
        # Validate every ancestor again after mkdir (symlinks are never trusted).
        _safe_folder(folder, library)
        if not row:
            con.execute("INSERT INTO material_storage_l1(l1_id,folder,origin) VALUES(?,?,?)",
                        (l1["id"], folder, origin))
        return {"l1Id": l1["id"], "l1Title": l1["title"],
                "folder": folder, "origin": origin, "ready": True}


def migration_inventory(db_path=None):
    """Read-only per-file candidate inventory. Never automatically moves bytes.

    Each canonical file is categorized as unique-L1 / shared / unlinked. This
    classification is necessary but not sufficient to authorize a move; HTML
    relative resources and historical references need explicit validation.
    """
    import json
    with store._lock, store._connection(db_path) as con:
        _schema(con)
        nodes = {row["id"]: dict(row) for row in con.execute(
            "SELECT id,title,kind,parent_id,deleted_at FROM records")}
        mapped = {row["l1_id"]: dict(row) for row in con.execute(
            "SELECT l1_id,folder,origin FROM material_storage_l1")}
        owners = {}
        def owner_id(node_id):
            seen = set()
            while node_id in nodes and node_id not in seen:
                seen.add(node_id)
                node = nodes[node_id]
                if node["deleted_at"]:
                    return None
                if node["parent_id"] is None:
                    return node_id if node["kind"] in KINDS else None
                node_id = node["parent_id"]
            return None
        for row in con.execute("""SELECT l.source_id,m.data FROM links l
            JOIN records m ON m.id=l.target_id WHERE m.kind='material'
            AND m.deleted_at IS NULL"""):
            l1 = owner_id(row["source_id"])
            if not l1:
                continue
            try:
                fid = json.loads(row["data"]).get("fileId")
            except (ValueError, TypeError, AttributeError):
                continue
            if isinstance(fid, str):
                owners.setdefault(fid, set()).add(l1)
        with file_hub._db() as hub:
            for row in hub.execute("""SELECT file_id,target_id,relation FROM links
                WHERE relation!='note-image'"""):
                l1 = owner_id(row["target_id"])
                if l1:
                    owners.setdefault(row["file_id"], set()).add(l1)
            records = []
            summary = {"unique":0, "shared":0, "unlinked":0, "alreadyMapped":0}
            for row in hub.execute("SELECT id,path,sha,revision,deleted FROM files ORDER BY path"):
                refs = sorted(owners.get(row["id"], set()))
                status = "shared" if len(refs)>1 else "unique" if refs else "unlinked"
                if len(refs)==1 and row["path"].startswith(mapped.get(refs[0], {}).get("folder", "") + "/"):
                    status = "alreadyMapped"
                summary[status] += 1
                records.append({"fileId":row["id"],"path":row["path"],
                    "sha256":row["sha"],"revision":row["revision"],"deleted":bool(row["deleted"]),
                    "ownerL1Ids":refs,"status":status})
        groups = [{"l1Id":row["id"],"title":row["title"],
                   "folder":mapped.get(row["id"], {}).get("folder"),
                   "origin":mapped.get(row["id"], {}).get("origin", "unmapped")}
                  for row in nodes.values()
                  if row["parent_id"] is None and row["kind"] in KINDS and not row["deleted_at"]]
        groups.sort(key=lambda r:r["title"].casefold())
        return {"l1":groups,"summary":summary,"files":records,
                "automaticLegacyMoves":0,
                "note":"Candidates require verified backups, SHA256 manifests, relative-asset checks and a separate guarded cutover."}
