"""KB_Work-only housekeeping with explicit, manifest-backed destructive commands.

Safe defaults are always read-only. Mutations require a named --confirm flag.
No operation accesses KB_Site, content/, library/, projects/ or a live Work DB.
Run from the local Work machine after reviewing the dry-run output.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import signal
import stat
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
MARKER = "KB_WORK_STANDALONE_V1"
ARCHIVE_DIR = ".backups"
JOURNAL_DIR = ".maintenance/cleanup-plans"
ARCHIVE_RE = re.compile(r"^KB_Work_(?:Private_)?[0-9]{8}T[0-9]{6}Z\.zip(?:\.incomplete)?$")


class CleanupRefused(RuntimeError):
    pass


def _root(root):
    root = Path(root).resolve(strict=True)
    if root.name != "KB_Work" or (root / "WORKSPACE_KIND").read_text(encoding="utf-8").strip() != MARKER:
        raise CleanupRefused("Not the standalone KB_Work root")
    return root


def _inventory(root):
    folder = root / ARCHIVE_DIR
    if not folder.exists():
        return []
    if folder.is_symlink() or not folder.is_dir():
        raise CleanupRefused("Backup path is not a regular directory")
    rows = []
    for entry in sorted(folder.iterdir(), key=lambda item: item.name):
        meta = entry.lstat()
        if not stat.S_ISREG(meta.st_mode) or not ARCHIVE_RE.fullmatch(entry.name):
            raise CleanupRefused("Unexpected backup item; refusing bulk delete: " + entry.name)
        rows.append({"name": entry.name, "bytes": meta.st_size,
                     "inode": meta.st_ino, "device": meta.st_dev})
    return rows


def plan_backups(root=ROOT):
    root = _root(root)
    rows = _inventory(root)
    return {"operation": "prune-backups", "directory": str(root / ARCHIVE_DIR),
            "files": len(rows), "bytes": sum(x["bytes"] for x in rows),
            "entries": rows, "dryRun": True}


def _journal(root, operation, rows):
    folder = root / JOURNAL_DIR
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output = folder / f"{operation}-{stamp}.json"
    with output.open("x", encoding="utf-8") as stream:
        json.dump({"operation": operation, "createdUtc": stamp,
                   "root": str(root), "items": rows}, stream, indent=2)
    return output


def prune_backups(root=ROOT, *, confirm=False):
    root = _root(root)
    rows = _inventory(root)
    if not confirm:
        return plan_backups(root)
    # Refuse without a persisted irreversible-deletion inventory.
    manifest = _journal(root, "backup-removal", rows)
    deleted = []
    for item in rows:
        target = root / ARCHIVE_DIR / item["name"]
        meta = target.lstat()
        if (not stat.S_ISREG(meta.st_mode) or meta.st_ino != item["inode"]
                or meta.st_dev != item["device"] or meta.st_size != item["bytes"]):
            raise CleanupRefused("Backup changed since inventory: " + item["name"])
        target.unlink()
        deleted.append(item["name"])
    remaining = _inventory(root)
    if remaining:
        raise CleanupRefused("Some archives remain; inspect manifest: " + str(manifest))
    return {"operation": "prune-backups", "deleted": len(deleted),
            "freedBytes": sum(x["bytes"] for x in rows),
            "remaining": 0, "manifest": str(manifest)}


def _process_info(pid):
    """Only the precise deleted temporary server process is eligible."""
    proc = Path("/proc") / str(pid)
    try:
        argv = [x.decode(errors="replace") for x in (proc / "cmdline").read_bytes().split(b"\0") if x]
        cwd = os.readlink(proc / "cwd")
        status = (proc / "stat").read_text(encoding="utf-8")
    except (OSError, PermissionError):
        return None
    if len(argv) < 3 or not any(x == "tools/work_server.py" for x in argv):
        return None
    index = argv.index("tools/work_server.py")
    if index + 1 >= len(argv) or not argv[index + 1].isdigit():
        return None
    port = int(argv[index + 1])
    if port == 8001 or not 1 <= port <= 65535:
        return None
    # The previous test leak had /tmp/kb-work-test-*/... (deleted) and
    # /tmp/kb-work-clean-gitlab-*/clone (deleted). Never stop a live checkout.
    temp = str(Path(tempfile.gettempdir()).resolve()) + os.sep
    if not cwd.startswith(temp) or not cwd.endswith(" (deleted)"):
        return None
    relative = cwd[len(temp):]
    if not relative.startswith(("kb-work-test-", "kb-work-clean-gitlab-")):
        return None
    # Start ticks protect against accidentally terminating a reused PID.
    try:
        start_ticks = status.rsplit(")", 1)[1].split()[19]
    except (IndexError, ValueError):
        return None
    return {"pid": pid, "port": port, "cwd": cwd, "startTicks": start_ticks}


def plan_orphan_servers():
    records = []
    for path in sorted(Path("/proc").iterdir()):
        if path.name.isdigit():
            data = _process_info(int(path.name))
            if data:
                records.append(data)
    return {"operation": "stop-orphan-servers", "count": len(records),
            "entries": records, "dryRun": True}


def stop_orphan_servers(*, confirm=False, root=ROOT):
    root = _root(root)
    planned = plan_orphan_servers()["entries"]
    if not confirm:
        return {"operation": "stop-orphan-servers", "count": len(planned),
                "entries": planned, "dryRun": True}
    manifest = _journal(root, "orphan-process-stop", planned)
    stopped = []
    for item in planned:
        current = _process_info(item["pid"])
        if current != item:
            continue
        try:
            os.kill(item["pid"], signal.SIGTERM)
        except ProcessLookupError:
            continue
        for _ in range(30):
            if _process_info(item["pid"]) is None:
                break
            time.sleep(0.1)
        else:
            if _process_info(item["pid"]) == item:
                os.kill(item["pid"], signal.SIGKILL)
        stopped.append(item["pid"])
    return {"operation": "stop-orphan-servers", "stopped": stopped,
            "remaining": len(plan_orphan_servers()["entries"]),
            "manifest": str(manifest)}


def plan_stale_pid_files(root=ROOT):
    root = _root(root)
    folder = root / ".maintenance"
    entries = []
    if folder.exists():
        for item in sorted(folder.glob("server-*.pid.json")):
            if not item.is_file() or item.is_symlink():
                continue
            try:
                record = json.loads(item.read_text(encoding="utf-8"))
            except (ValueError, OSError):
                continue
            pid = record.get("pid")
            if record.get("root") != str(root) or not isinstance(pid, int):
                continue
            if Path("/proc").joinpath(str(pid)).exists():
                continue
            entries.append({"name": item.name, "pid": pid, "bytes": item.stat().st_size})
    return {"operation": "prune-stale-pids", "files": len(entries),
            "entries": entries, "dryRun": True}


def prune_stale_pid_files(root=ROOT, *, confirm=False):
    root = _root(root)
    plan = plan_stale_pid_files(root)
    if not confirm:
        return plan
    manifest = _journal(root, "stale-pid-removal", plan["entries"])
    removed = []
    for item in plan["entries"]:
        path = root / ".maintenance" / item["name"]
        if not path.is_file() or path.is_symlink():
            continue
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        if record.get("pid") != item["pid"] or Path("/proc").joinpath(str(item["pid"])).exists():
            continue
        path.unlink()
        removed.append(item["name"])
    return {"operation": "prune-stale-pids", "removed": removed,
            "remaining": plan_stale_pid_files(root)["files"], "manifest": str(manifest)}


def main():
    parser = argparse.ArgumentParser(description="KB_Work local housekeeping; defaults to dry run")
    parser.add_argument("action", choices=("prune-backups", "stop-orphan-servers", "prune-stale-pids"))
    parser.add_argument("--confirm", action="store_true", help="execute the exact local cleanup")
    args = parser.parse_args()
    action = {"prune-backups": prune_backups,
              "stop-orphan-servers": stop_orphan_servers,
              "prune-stale-pids": prune_stale_pid_files}[args.action]
    try:
        report = action(confirm=args.confirm)
    except (CleanupRefused, OSError, ValueError) as exc:
        parser.exit(2, "REFUSED: " + str(exc) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
