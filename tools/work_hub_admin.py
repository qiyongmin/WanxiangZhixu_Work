"""Phase 4 administration: backup verification, switch acceptance, Shell root switch/rollback.

* ``backup_verify``  - verify the newest Work_Backup, restore it into a *new temporary
  directory* and compare record / revision / link / File Hub file counts with the source.
* ``integrity_view`` - the switch acceptance checklist (design: four named checks).
* ``shell_switch`` / ``shell_rollback`` - write ``work_meta('shell.root')``; nothing else.

Everything reads the source through read-only connections. The only write is the single
``work_meta`` row, inside ``store.tx``.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import shutil
import sqlite3
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import quote

import work_hub_nodes as nodes
import work_hub_schema as schema
import work_hub_sections as sections
import work_hub_store as store
import work_migrate
import work_shell

ROOT = Path(__file__).resolve().parents[1]
TMP_PREFIX = "kb-work-verify-"
META_KEY = "shell.root"
CHECK_NAMES = ("records_visible", "revisions_match", "files_verified", "backup_verified")
CHECK_LABELS = {
    "records_visible": "迁前记录在新版全部可见",
    "revisions_match": "每条记录的 Revision 数与动态一致",
    "files_verified": "File Hub 文件可预览且 SHA256 一致",
    "backup_verified": "备份验证（24 小时内）通过",
}
CATEGORY_LABELS = {"records": "记录", "revisions": "Revision", "links": "关联", "files": "File Hub 文件"}
CATEGORIES = tuple(CATEGORY_LABELS)
PASS, FAIL, PENDING = "pass", "fail", "pending"
MAX_BACKUP_AGE_HOURS = 24


class AdminError(ValueError):
    """Failure with the HTTP status / machine code the API layer maps."""

    def __init__(self, message, *, code="invalid_request", status=400, details=None):
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details or {}


# --------------------------------------------------------------------------
# Small read helpers (read-only connections; never create a missing file)
# --------------------------------------------------------------------------
def _root(ctx_root):
    return Path(ctx_root) if ctx_root is not None else ROOT


def _ro(path):
    con = sqlite3.connect("file:%s?mode=ro" % quote(Path(path).as_posix()), uri=True)
    con.row_factory = sqlite3.Row
    return con


def _count(path, table):
    """Row count of ``table`` in the SQLite file, or 0 when the file/table does not exist."""
    if not Path(path).is_file():
        return 0
    try:
        with contextlib.closing(_ro(path)) as con:
            return con.execute("SELECT COUNT(*) FROM %s" % table).fetchone()[0]
    except sqlite3.Error:
        return 0


def _work_db(root):
    return Path(root) / "content" / "work-hub" / "work.sqlite3"


def _catalog(root):
    return Path(root) / "content" / "file-hub" / "catalog.sqlite3"


def _counts(db, catalog):
    return {"records": _count(db, "records"), "revisions": _count(db, "revisions"),
            "links": _count(db, "links"), "files": _count(catalog, "files")}


def _sha_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


# --------------------------------------------------------------------------
# backup-verify
# --------------------------------------------------------------------------
def _restore_target(parent):
    """Path for the restored tree; must not exist yet (``work_backup.restore`` requires that)."""
    return Path(parent) / "restored"


def _newest_backup(backup_dir):
    found = work_migrate._candidates(backup_dir)
    return found[0] if found else None


def _age_hours(archive, now):
    import zipfile
    try:
        with zipfile.ZipFile(archive) as zf:
            manifest = json.loads(zf.read(work_migrate.MANIFEST))
        created = work_migrate.parse_created_utc(manifest.get("createdUtc"))
    except (OSError, KeyError, ValueError, zipfile.BadZipFile):
        return None
    if isinstance(now, str):
        try:
            now = datetime.fromisoformat(now.replace("Z", "+00:00"))
        except ValueError:
            now = None
    return round((work_migrate._utc(now) - created).total_seconds() / 3600, 3)


def backup_verify(db, root=None, backup_dir=None, now=None):
    """Verify + restore the newest Work_Backup into a fresh temp dir and compare counts.

    Always returns a report (``passed`` False with ``failures`` on any problem); the source
    database, the live catalog and the archive are never modified, and the temp directory is
    removed whether or not the check succeeds.
    """
    import work_backup
    base = _root(root)
    source = _counts(Path(db), _catalog(base))
    report = {"passed": False, "fresh": False, "archive": None, "ageHours": None,
              "rows": [], "failures": []}

    def fail(category, reason):
        report["failures"].append({"category": category, "label": CATEGORY_LABELS.get(category, "备份文件"),
                                   "reason": reason})

    archive = _newest_backup(backup_dir if backup_dir is not None else base / ".backups")
    if archive is None:
        fail("archive", "没有找到备份。请先执行 " + work_migrate.BACKUP_HINT)
        return report
    report["archive"] = str(archive)
    report["ageHours"] = _age_hours(archive, now)
    report["fresh"] = report["ageHours"] is not None and 0 <= report["ageHours"] <= MAX_BACKUP_AGE_HOURS
    try:
        work_backup.verify(archive)
    except Exception as exc:  # noqa: BLE001 - any verification failure is a reportable result
        fail("archive", "备份校验未通过: %s" % exc)
        return report
    scratch = Path(tempfile.mkdtemp(prefix=TMP_PREFIX))
    try:
        target = _restore_target(scratch)
        try:
            work_backup.restore(archive, target)
        except Exception as exc:  # noqa: BLE001
            fail("restore", "恢复到新目录失败: %s" % exc)
            return report
        restored = _counts(_work_db(target), _catalog(target))
        for category in CATEGORIES:
            match = source[category] == restored[category]
            report["rows"].append({"category": category, "label": CATEGORY_LABELS[category],
                                   "source": source[category], "restored": restored[category],
                                   "match": match})
            if not match:
                fail(category, "源 %d 条，恢复 %d 条" % (source[category], restored[category]))
    finally:
        shutil.rmtree(scratch, ignore_errors=True)       # our own scratch dir only
    report["passed"] = not report["failures"]
    return report


# --------------------------------------------------------------------------
# Acceptance checklist
# --------------------------------------------------------------------------
def _check(name, status, detail):
    return {"name": name, "label": CHECK_LABELS[name], "status": status, "ok": status == PASS,
            "detail": detail}


def _baseline_records(con):
    try:
        row = con.execute("SELECT value FROM work_meta WHERE key='baseline'").fetchone()
        return int(json.loads(row[0])["records"]["rows"]) if row else None
    except (sqlite3.Error, ValueError, KeyError, TypeError):
        return None


def _check_records_visible(db):
    tree_ids = {n["id"] for n in nodes.tree_view(path=db)["nodes"]}
    with contextlib.closing(_ro(db)) as con:
        rows = {r["id"]: dict(r) for r in con.execute(
            "SELECT id,kind,parent_id,archived_at,deleted_at FROM records")}
        baseline = _baseline_records(con)

    def under_archive(row):
        seen, current = set(), row
        while current is not None and current["id"] not in seen:
            seen.add(current["id"])
            if current["archived_at"]:
                return True
            current = rows.get(current["parent_id"])
        return False

    hidden = []
    undeleted = [r for r in rows.values() if not r["deleted_at"]]
    for row in undeleted:
        if row["id"] in tree_ids or row["kind"] == "material":
            continue
        if row["kind"] in sections.TREE_KINDS and under_archive(row) \
                and not _ancestor_deleted(rows, row):
            continue                                        # archived: reachable through the node view
        hidden.append(row["id"])
    detail = "可见 %d / 未删除 %d" % (len(undeleted) - len(hidden), len(undeleted))
    ok = not hidden
    if baseline is not None:
        detail += "；迁前快照 %d 条，当前共 %d 条" % (baseline, len(rows))
        ok = ok and len(rows) >= baseline
    if hidden:
        detail += "；不可见: " + ", ".join(sorted(hidden)[:10])
    return _check("records_visible", PASS if ok else FAIL, detail)


def _ancestor_deleted(rows, row):
    seen, current = set(), rows.get(row["parent_id"])
    while current is not None and current["id"] not in seen:
        seen.add(current["id"])
        if current["deleted_at"]:
            return True
        current = rows.get(current["parent_id"])
    return False


def _check_revisions_match(db):
    with contextlib.closing(_ro(db)) as con:
        expected = {r[0]: r[1] for r in con.execute(
            "SELECT r.id,(SELECT COUNT(*) FROM revisions v WHERE v.record_id=r.id) "
            "FROM records r WHERE r.deleted_at IS NULL")}
    bad = []
    for record_id, total in expected.items():
        fetched, before = 0, None
        while True:
            page = nodes.activity_view(record_id, limit=nodes.MAX_LIMIT, before=before, path=db)
            fetched += len(page["items"])
            before = page["nextBefore"]
            if before is None:
                break
        if fetched != total:
            bad.append("%s(%d≠%d)" % (record_id, fetched, total))
    detail = "已核对 %d 条记录" % len(expected)
    if bad:
        detail += "；不一致: " + ", ".join(sorted(bad)[:10])
    return _check("revisions_match", FAIL if bad else PASS, detail)


_PREVIEWABLE = {"md": "markdown", "markdown": "markdown", "txt": "text", "html": "html", "pdf": "pdf",
                "png": "image", "jpg": "image", "jpeg": "image", "gif": "image", "webp": "image"}


def preview_kind(name):
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return _PREVIEWABLE.get(ext, "other")


def _check_files_verified(root):
    catalog = _catalog(root)
    library = Path(root) / "library"
    if not catalog.is_file():
        return _check("files_verified", PASS, "没有 File Hub 目录，无文件需要核对")
    bad, total = [], 0
    try:
        with contextlib.closing(_ro(catalog)) as con:
            rows = con.execute("SELECT id,path,sha FROM files WHERE deleted=0 ORDER BY path").fetchall()
    except sqlite3.Error as exc:
        return _check("files_verified", FAIL, "无法读取 File Hub 目录: %s" % exc)
    for row in rows:
        total += 1
        target = (library / row["path"]).resolve()
        try:
            target.relative_to(library.resolve())
            preview_kind(row["path"])                       # always resolves (``other`` = info card)
            ok = target.is_file() and _sha_file(target) == row["sha"]
        except (ValueError, OSError):
            ok = False
        if not ok:
            bad.append(row["id"])
    detail = "已核对 %d 个文件" % total
    if bad:
        detail += "；SHA256 不一致或缺失: " + ", ".join(bad[:10])
    return _check("files_verified", FAIL if bad else PASS, detail)


def _check_backup(report):
    if report is None:
        return _check("backup_verified", PENDING, "尚未验证；请先点击「备份验证」")
    if not report["passed"]:
        return _check("backup_verified", FAIL, "；".join(f["reason"] for f in report["failures"]) or "未通过")
    if not report["fresh"]:
        return _check("backup_verified", FAIL, "备份已超过 %d 小时，请重新创建备份" % MAX_BACKUP_AGE_HOURS)
    return _check("backup_verified", PASS, "备份 %s 已验证" % Path(report["archive"]).name)


def integrity_view(db, root=None, include_backup=False, backup_dir=None, now=None):
    """Counts plus the four acceptance checks. ``include_backup`` runs the (slow) backup-verify."""
    base = _root(root)
    report = backup_verify(db, base, backup_dir, now) if include_backup else None
    checks = [_check_records_visible(db), _check_revisions_match(db), _check_files_verified(base),
              _check_backup(report)]
    return {"counts": _counts(Path(db), _catalog(base)), "checks": checks,
            "backup": report, "shellRoot": "shell" if work_shell.root_is_shell(db) else "legacy",
            "accepted": all(c["ok"] for c in checks)}


# --------------------------------------------------------------------------
# switch / rollback
# --------------------------------------------------------------------------
def _write_root(db, value):
    with store.tx(db) as con:
        schema.require_migrated(con)
        con.execute("INSERT OR REPLACE INTO work_meta(key,value,updated_at) VALUES(?,?,?)",
                    (META_KEY, value, store._now()))
    work_shell.invalidate_root_cache()


def shell_switch(db, root=None, backup_dir=None, now=None):
    view = integrity_view(db, root, include_backup=True, backup_dir=backup_dir, now=now)
    failed = [c["name"] for c in view["checks"] if not c["ok"]]
    if failed:
        raise AdminError("验收未通过，根路径保持 Legacy：" + "、".join(CHECK_LABELS[n] for n in failed),
                         code="acceptance_failed", status=409,
                         details={"failed": failed, "checks": view["checks"]})
    _write_root(db, "react")
    return {"shellRoot": "shell", "checks": view["checks"]}


def shell_rollback(db):
    _write_root(db, "legacy")
    return {"shellRoot": "legacy"}
