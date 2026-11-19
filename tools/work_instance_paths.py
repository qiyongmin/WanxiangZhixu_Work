#!/usr/bin/env python3
"""Optional external KB_Work instance root, preserving standalone defaults.

No implicit migration or changes to the checked-out source. An external instance
is explicit and its directory must be an absolute WSL Linux filesystem path.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import uuid

CODE = Path(__file__).resolve().parents[1]
MARKER = "KB_WORK_STANDALONE_V1"
INSTANCE_MARKER = "KB_WORK_LOCAL_DATA_V1"
DBS = ("content/work-hub/work.sqlite3", "content/file-hub/catalog.sqlite3")
PATHS = {
    "KB_WORK_HUB_DB": "content/work-hub/work.sqlite3",
    "KB_WORK_HUB_MEDIA": "content/work-hub/media",
    "KB_FILE_HUB_DATA": "content/file-hub",
    "KB_FILE_HUB_LIBRARY": "library",
}

class InstanceError(ValueError):
    pass

def require_code_root() -> None:
    if not (CODE / "WORKSPACE_KIND").is_file() or (CODE / "WORKSPACE_KIND").read_text(encoding="utf-8").strip() != MARKER:
        raise InstanceError("Not a verified standalone KB_Work checkout")

def resolve(path: str | Path, *, exists: bool = True) -> Path:
    require_code_root()
    value = str(path)
    if not value or value != value.strip() or value.startswith("~") and value == "~":
        raise InstanceError("Provide an absolute WSL data directory path")
    p = Path(os.path.expanduser(value))
    if not p.is_absolute():
        raise InstanceError("Data root must be absolute")
    if p == Path("/") or "/.." in value or "/./" in value:
        raise InstanceError("Unsafe data root path")
    # No symlinks in parent chain (including symlinks whose targets are outside
    # the repo); all subsequent access uses the same normalized path.
    for part in (p, *p.parents):
        if part.is_symlink():
            raise InstanceError("Data root path contains a symlink")
    p = p.resolve(strict=False)
    code = CODE.resolve()
    personal = code.parent / 'KB_Site'  # Compare paths only; do not read/access it.
    if p == code or code in p.parents or p in code.parents:
        raise InstanceError("Data root and source checkout must be separate")
    if p == personal or personal in p.parents:
        raise InstanceError("Data root may not be inside the personal KB_Site")
    if p.parts[:2] == ("/", "mnt") or p.parts[:2] == ("/", "media"):
        raise InstanceError("Use the WSL Linux filesystem, not a mounted Windows/network drive")
    if exists:
        if not p.is_dir():
            raise InstanceError("Initialize the external Data Root explicitly before use")
        if p.stat().st_uid != os.getuid():
            raise InstanceError("Data Root is not owned by the current WSL user")
        if stat.S_IMODE(p.stat().st_mode) & 0o077:
            raise InstanceError("Data Root permissions must be 0700")
    return p

def env_paths(root: Path) -> dict[str, str]:
    return {key: str(root / suffix) for key, suffix in PATHS.items()}

def verify(path: str | Path) -> dict:
    root = resolve(path)
    marker = root / "instance.json"
    if marker.is_symlink() or not marker.is_file() or stat.S_IMODE(marker.stat().st_mode) & 0o077:
        raise InstanceError("Private instance.json missing or unsafe")
    data = json.loads(marker.read_text(encoding="utf-8"))
    if data.get("format") != INSTANCE_MARKER or not isinstance(data.get("instanceId"), str):
        raise InstanceError("Wrong instance format")
    result = {}
    for rel in DBS:
        db_path = root / rel
        if not db_path.is_file() or db_path.is_symlink():
            raise InstanceError("Missing instance database: " + rel)
        con = sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)
        try:
            integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
            if integrity != "ok":
                raise InstanceError("Instance database corruption: " + rel)
            foreign = con.execute("PRAGMA foreign_key_check").fetchall()
            if foreign:
                raise InstanceError("Broken foreign keys in " + rel)
            result[rel] = {"integrity": integrity, "foreignKeys": 0}
        finally:
            con.close()
    library = root / "library"
    if not library.is_dir() or library.is_symlink():
        raise InstanceError("Library directory missing")
    return {"ready": True, "format": INSTANCE_MARKER, "databases": result,
            "dataRoot": str(root), "serverRequired": False}

def initialize(path: str | Path) -> dict:
    root = resolve(path, exists=False)
    if root.exists():
        raise InstanceError("Refusing to initialize an existing directory")
    if not root.parent.is_dir() or root.parent.is_symlink():
        raise InstanceError("Parent directory must exist and not be a symlink")
    # Same-user-only access before anything is created, and never remove data
    # after an error (manual investigation preserves all partial artifacts).
    root.mkdir(mode=0o700)
    try:
        (root / "WORKSPACE_KIND").write_text(MARKER + "\n", encoding="utf-8")
        import work_init
        report = work_init.initialize(root)
        # File Hub determines paths at import time. Use a fresh, isolated
        # process with explicit environment instead of polluting this process
        # or accidentally reusing another workspace's cached module globals.
        proc = subprocess.run(
            [sys.executable, "-c",
             "import file_hub; c=file_hub._db(); "
             "assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'; c.close()"],
            cwd=CODE / "tools", env={**os.environ, **env_paths(root)},
            text=True, capture_output=True, timeout=30)
        if proc.returncode:
            raise InstanceError("File Hub initialization failed in isolated process: " + proc.stderr[-500:])
        for name in ("agents/private/skills", "config", "logs", "cache", "projects"):
            (root / name).mkdir(parents=True, exist_ok=True)
        marker = root / "instance.json"
        data = {"format": INSTANCE_MARKER, "instanceId": str(uuid.uuid4()),
                "createdUtc": datetime.now(timezone.utc).isoformat(),
                "mode": "local", "dataSchema": 1}
        fd = os.open(str(marker), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(data, output, indent=2)
            output.write("\n")
        verification = verify(root)
        # Build only the local instance's Skills metadata. Nothing is staged
        # to Git or copied to a central endpoint. Run in a fresh process so
        # project_skills resolves this new root rather than a cached checkout.
        for command in ([sys.executable, 'work_skill_layers.py', 'build-private', '--data-root', str(root)],
                        [sys.executable, 'project_skills.py', 'build']):
            proc = subprocess.run(command, cwd=CODE/'tools',
                                  env={**os.environ, 'KB_WORK_DATA_ROOT':str(root)},
                                  capture_output=True,text=True,timeout=30)
            if proc.returncode:
                raise InstanceError('Local-only Skills initialization failed: '+proc.stderr[-400:])
        return {"status": "created", "sections": report["sectionTitles"], **verification}
    except BaseException:
        raise  # Never erase or overwrite partial Work data.

def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=("init", "verify", "resolve", "environment"))
    p.add_argument("--path", required=True)
    a = p.parse_args()
    try:
        if a.action == "init":
            out = initialize(a.path)
        elif a.action == "verify":
            out = verify(a.path)
        elif a.action == "resolve":
            print(resolve(a.path))
            return 0
        else:
            root = resolve(a.path)
            verify(root)
            out = {"root": str(root), "environment": env_paths(root)}
        print(json.dumps(out, ensure_ascii=False, indent=2))
    except (OSError, ValueError, sqlite3.Error, json.JSONDecodeError) as error:
        print("Refused external Data Root: " + str(error), file=sys.stderr)
        return 2
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
