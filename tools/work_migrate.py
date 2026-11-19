"""Explicit, backup-gated, transactional migration of the Work database to schema v2.

Usage:
  python3 tools/work_migrate.py status   # read-only
  python3 tools/work_migrate.py apply    # needs a valid Work_Backup (<= 24 h old)

Migration is never triggered by server start-up. It only *adds* the ``work_*``
tables and seed Sections; the four legacy tables are verified byte-for-byte
unchanged (per-table SHA-256 before and after, inside the same transaction).
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import sys
import unicodedata
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

import work_hub_schema as schema  # noqa: E402
import work_hub_sections as sections  # noqa: E402
import work_hub_store as store  # noqa: E402

BACKUP_DIR = ROOT / ".backups"
FORMAL_DB = ROOT / "content/work-hub/work.sqlite3"
MANIFEST = "WORK_BACKUP_MANIFEST.json"
MAX_AGE = timedelta(hours=24)
MAX_FUTURE = timedelta(minutes=5)
CANDIDATES = 3
BACKUP_HINT = "python3 tools/work_backup.py create"
NOTE_LIMIT = 50
NOTE_BYTES_LIMIT = 6 * 1024 * 1024
MAX_DEPTH = 4
# table -> primary-key ordering used for the summaries (same recipe as the Phase 0 baseline)
_ORDER = {"records": "id", "revisions": "event_id",
          "links": "source_id,target_id,relation", "proposals": "id"}


class BackupRequired(RuntimeError):
    """No valid, recent Work_Backup exists; the database was not opened for writing."""

    code = "backup_required"
    status = 409


class MigrationError(RuntimeError):
    """A migration invariant failed; the transaction was rolled back."""


# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
def _utc(value):
    if value is None:
        return datetime.now(timezone.utc)
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _iso(value):
    return value.isoformat()


def parse_created_utc(text):
    """Parse ``manifest.createdUtc``: compact ``YYYYMMDDTHHMMSSZ`` or ISO-8601."""
    if not isinstance(text, str) or not text:
        raise ValueError("createdUtc missing")
    try:
        return datetime.strptime(text, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    except ValueError:
        pass
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("createdUtc unparseable: " + text) from exc
    return _utc(parsed)


def is_formal_db(db_path):
    target = Path(db_path).resolve()
    formal = FORMAL_DB.resolve()
    if target == formal:
        return True
    try:
        return target.exists() and formal.exists() and target.samefile(formal)
    except OSError:
        return True  # cannot prove it is not the live database -> treat as live


def _sha_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def table_digests(con):
    """``{table: {"rows": n, "sha256": ...}}`` over the four legacy tables.

    sha256 = SHA-256 of the concatenated ``repr(tuple(row))`` ordered by primary key.
    """
    result = {}
    for table, order in _ORDER.items():
        digest = hashlib.sha256()
        count = 0
        for row in con.execute(f"SELECT * FROM {table} ORDER BY {order}"):
            digest.update(repr(tuple(row)).encode("utf-8"))
            count += 1
        result[table] = {"rows": count, "sha256": digest.hexdigest()}
    return result


# --------------------------------------------------------------------------
# Backup gate
# --------------------------------------------------------------------------
def _candidates(backup_dir):
    base = Path(backup_dir)
    if not base.is_dir():
        return []
    # ``KB_Work_*.zip`` cannot match ``*.zip.incomplete``.
    names = sorted((p for p in base.glob("KB_Work_*.zip") if p.is_file()),
                   key=lambda p: p.name, reverse=True)
    return names[:CANDIDATES]


def _inspect_candidate(archive, now):
    """Return ``(evidence | None, reason | None)`` for one archive."""
    try:
        with zipfile.ZipFile(archive) as zf:
            manifest = json.loads(zf.read(MANIFEST))
        created = parse_created_utc(manifest.get("createdUtc"))
    except (OSError, KeyError, ValueError, zipfile.BadZipFile) as exc:
        return None, f"{archive.name}: manifest unreadable ({exc})"
    age = now - created
    if age > MAX_AGE:
        return None, f"{archive.name}: older than 24 hours ({age})"
    if created - now > MAX_FUTURE:
        return None, f"{archive.name}: createdUtc is in the future"
    return {"path": str(archive), "createdUtc": manifest.get("createdUtc"),
            "ageHours": round(age.total_seconds() / 3600, 3)}, None


def find_valid_backup(now=None, *, backup_dir=None):
    """Newest verified backup created within [now-24h, now+5min].

    Only the 3 newest ``KB_Work_*.zip`` are considered. Raises ``BackupRequired``
    (no write connection exists yet) when none qualifies.
    """
    now = _utc(now)
    reasons = []
    for archive in _candidates(backup_dir or BACKUP_DIR):
        evidence, reason = _inspect_candidate(archive, now)
        if evidence is None:
            reasons.append(reason)
            continue
        try:
            import work_backup
            report = work_backup.verify(archive)
        except Exception as exc:  # noqa: BLE001 - any verify failure disqualifies the archive
            reasons.append(f"{archive.name}: verification failed ({exc})")
            continue
        evidence["verified"] = True
        evidence["fileCount"] = report.get("fileCount")
        evidence["sha256"] = _sha_file(archive)
        return evidence
    detail = "; ".join(reasons) if reasons else "no KB_Work_*.zip archive found"
    raise BackupRequired("需要 24 小时内的有效 Work_Backup（" + detail + "）。请先执行 " + BACKUP_HINT)


def backup_status(now=None, *, backup_dir=None):
    """Non-raising summary for ``view=schema`` / ``status``."""
    now = _utc(now)
    candidates = _candidates(backup_dir or BACKUP_DIR)
    newest = candidates[0].name if candidates else None
    try:
        evidence = find_valid_backup(now, backup_dir=backup_dir)
    except BackupRequired as exc:
        return {"ok": False, "newest": newest, "ageHours": None, "reason": str(exc)}
    return {"ok": True, "newest": Path(evidence["path"]).name,
            "ageHours": evidence["ageHours"], "reason": None}


# --------------------------------------------------------------------------
# State
# --------------------------------------------------------------------------
def read_state(db_path):
    """Read-only migration state; never creates or writes the file."""
    target = Path(db_path)
    if not target.exists():
        return {"exists": False, "migrated": False, "schemaVersion": 0,
                "missing": list(schema.TABLES + schema.INDEXES)}
    con = sqlite3.connect(f"file:{target}?mode=ro", uri=True)
    try:
        return {"exists": True, "migrated": schema.is_migrated(con),
                "schemaVersion": schema.schema_version(con),
                "missing": schema.missing_objects(con)}
    finally:
        con.close()


# --------------------------------------------------------------------------
# Migration steps (small named functions so tests can inject failures)
# --------------------------------------------------------------------------
def _run_ddl(con):
    for statement in schema.DDL:
        con.execute(statement)


def _seed_sections(con, now_text):
    inserted = 0
    for section_id, title, order, item_kind, rules in sections.SEED_SECTIONS:
        cursor = con.execute(
            "INSERT OR IGNORE INTO work_sections"
            "(id,title,title_key,sort_order,item_kind,rules_json,created_at,updated_at)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (section_id, title, unicodedata.normalize("NFC", title.strip()).casefold(),
             order, item_kind,
             json.dumps(rules, sort_keys=True), now_text, now_text))
        inserted += cursor.rowcount
    return inserted


def _write_meta(con, now_text, backup, baseline):
    rows = (("schema_version", str(schema.SCHEMA_VERSION)),
            ("migratedAt", now_text),
            ("backup", json.dumps(backup, ensure_ascii=False, sort_keys=True)),
            ("baseline", json.dumps(baseline, ensure_ascii=False, sort_keys=True)))
    for key, value in rows:
        con.execute("INSERT OR REPLACE INTO work_meta(key,value,updated_at) VALUES(?,?,?)",
                    (key, value, now_text))


def _verify_invariants(con, before):
    after = table_digests(con)
    if after != before:
        changed = [t for t in before if before[t] != after[t]]
        raise MigrationError("既有表在迁移中发生变化: " + ", ".join(changed))
    violations = con.execute("PRAGMA foreign_key_check").fetchall()
    if violations:
        raise MigrationError(f"foreign_key_check 发现 {len(violations)} 处违例")


def _commit(con):
    con.execute("COMMIT")


def _preflight(con):
    """Warnings only (never blocks): data that the new rules would reject."""
    rows = {r["id"]: r for r in con.execute(
        "SELECT id,kind,parent_id,title,data,deleted_at FROM records")}

    def chain(record_id):
        seen, ids, current = set(), [], record_id
        while current is not None and current in rows and current not in seen:
            seen.add(current)
            ids.append(current)
            current = rows[current]["parent_id"]
        return ids

    report = {"teamManagementForbidden": [], "overDepth": [], "noteOverLimit": []}
    for record_id, row in rows.items():
        if row["deleted_at"]:
            continue
        ids = chain(record_id)
        top = rows[ids[-1]]
        if len(ids) > MAX_DEPTH and row["kind"] in sections.TREE_KINDS:
            report["overDepth"].append({"id": record_id, "depth": len(ids)})
        try:
            data = json.loads(row["data"])
        except (TypeError, ValueError):
            continue
        if sections.DEFAULT_SECTION_BY_KIND.get(top["kind"]) == sections.SEC_TEAM:
            for hit in sections.find_forbidden_keys(data):
                report["teamManagementForbidden"].append(
                    {"id": record_id, "path": hit["path"], "field": hit["field"]})
        notes = data.get("noteEntries") if isinstance(data, dict) else None
        if isinstance(notes, list):
            size = len(json.dumps(notes, ensure_ascii=False).encode("utf-8"))
            if len(notes) > NOTE_LIMIT or size > NOTE_BYTES_LIMIT:
                report["noteOverLimit"].append({"id": record_id, "notes": len(notes), "bytes": size})
    return report


def migrate(db_path=None, *, now=None, backup_check=None, backup_dir=None):
    """Migrate ``db_path`` (default: the live Work database) to schema v2.

    ``backup_check`` / ``backup_dir`` replace the backup gate for tests and are
    refused for the live database, so they cannot be used to bypass its gate.
    """
    target = Path(db_path) if db_path is not None else Path(store.DB_PATH)
    if is_formal_db(target) and (backup_check is not None or backup_dir is not None):
        raise ValueError("正式库的备份门禁不可被替换")
    now_dt = _utc(now)

    # 1. read-only detection: already migrated -> zero writes
    state = read_state(target)
    if state["migrated"]:
        return {"status": "already-migrated", "changed": 0}

    # 2. backup gate (no write connection exists yet)
    if backup_check is not None:
        outcome = backup_check(now_dt)
        if not outcome:
            raise BackupRequired("备份检查未通过。请先执行 " + BACKUP_HINT)
        backup = outcome if isinstance(outcome, dict) else {"stub": True}
    else:
        backup = find_valid_backup(now_dt, backup_dir=backup_dir)

    # 3-8. one IMMEDIATE transaction
    now_text = _iso(now_dt)
    with store._lock:
        con = store._connection(target)
        try:
            con.isolation_level = None
            con.execute("BEGIN IMMEDIATE")
            try:
                before = table_digests(con)
                report = _preflight(con)
                missing = len(schema.missing_objects(con))
                _run_ddl(con)
                seeded = _seed_sections(con, now_text)
                _write_meta(con, now_text, backup, before)
                _verify_invariants(con, before)
                _commit(con)
            except BaseException:
                if con.in_transaction:
                    con.execute("ROLLBACK")
                raise
            if con.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise MigrationError("integrity_check 未通过")
        finally:
            con.close()
    return {"status": "migrated", "changed": missing + seeded + 4, "backup": backup,
            "baseline": before, "sectionsSeeded": seeded, "report": report}


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description="Work Hub schema v2 migration")
    parser.add_argument("command", choices=("status", "apply"))
    args = parser.parse_args(argv)
    db = Path(store.DB_PATH)
    if args.command == "status":
        state = read_state(db)
        state["backup"] = backup_status()
        print(json.dumps(state, ensure_ascii=False, indent=2))
        return 0
    try:
        result = migrate(db)
    except BackupRequired as exc:
        print(json.dumps({"status": "refused", "error": str(exc), "hint": BACKUP_HINT},
                         ensure_ascii=False, indent=2), file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - surface any failure as a non-zero exit
        print(json.dumps({"status": "failed", "error": f"{type(exc).__name__}: {exc}"},
                         ensure_ascii=False, indent=2), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
