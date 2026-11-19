#!/usr/bin/env python3
"""Cold, local-only Data Root backup/restore. No source code or central upload.

Requires explicitly stopped/quiescent Work instance. The two SQLite databases
are online-snapshotted and the file inventory is checked before and after.
Restore never overwrites an existing directory or a running instance.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sqlite3
import stat
import sys
import tempfile
import zipfile

from work_instance_paths import resolve, verify as instance_verify, DBS

FORMAT = "kb-work-external-data-backup-v1"
MANIFEST = "KB_WORK_INSTANCE_MANIFEST.json"
FOLDERS = ("content", "library", "projects", "agents/private", "config", "data")
ROOT_ITEMS = ("instance.json", "WORKSPACE_KIND")
SKIP = {"logs", "cache", "__pycache__", ".git", ".maintenance", ".backups"}
SUFFIXES = ("-wal", "-shm", ".pyc")
REQUIRED = set(ROOT_ITEMS) | set(DBS)
OPTIONAL_DBS = ("content/ai-resources/registry.sqlite3",)

def sha(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for b in iter(lambda: stream.read(1024*1024), b""):
            h.update(b)
    return h.hexdigest()

def safe_rel(value: str) -> bool:
    path = PurePosixPath(value)
    return (isinstance(value, str) and value and "\\" not in value and ":" not in value
            and not path.is_absolute()
            and all(x not in ("", ".", "..") for x in path.parts)
            and path.parts[0] not in SKIP)

def files(root: Path) -> list[tuple[str, Path]]:
    names: list[tuple[str, Path]] = []
    for name in ROOT_ITEMS:
        file = root / name
        if not file.is_file() or file.is_symlink():
            raise ValueError("Missing/unsafe instance metadata: " + name)
        names.append((name, file))
    for folder in FOLDERS:
        base = root / folder
        if not base.exists():
            continue
        if base.is_symlink():
            raise ValueError("Symlink directory not permitted: " + folder)
        for here, dirs, listed in os.walk(base, followlinks=False):
            dirs[:] = sorted(x for x in dirs if x not in SKIP)
            if any((Path(here) / x).is_symlink() for x in dirs):
                raise ValueError("Symlink directory found")
            for filename in sorted(listed):
                item = Path(here) / filename
                rel = item.relative_to(root).as_posix()
                if filename.endswith(SUFFIXES):
                    continue
                safe_name = rel.replace(':Zone.Identifier', '.kbw-zone-identifier-sidecar') if rel.endswith(':Zone.Identifier') else rel
                if item.is_symlink() or not item.is_file() or not safe_rel(safe_name):
                    raise ValueError("Unsafe instance file: " + rel)
                names.append((rel, item))
    result = sorted(names)
    if not REQUIRED.issubset({name for name, _ in result}):
        raise ValueError("Incomplete external Work instance")
    return result

def sqlite_snapshot(source: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as live, sqlite3.connect(dest) as snap:
        live.backup(snap)
        if snap.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise ValueError("Corrupt SQLite snapshot: " + source.name)
        if snap.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Foreign key failure: " + source.name)

def create(root: Path, dest: Path, *, quiescent: bool) -> dict:
    if not quiescent:
        raise ValueError("Stop the Local Agent and confirm --quiescent before backup")
    root = resolve(root)
    instance_verify(root)
    dest = dest.expanduser().resolve(strict=False)
    if dest.exists() or dest.suffix.lower() != ".zip" or dest == root or root in dest.parents:
        raise ValueError("Choose a new .zip path outside the Data Root")
    selected = files(root)
    baseline = {rel:sha(p) for rel,p in selected}
    dest.parent.mkdir(parents=True,exist_ok=True)
    partial = dest.with_name(dest.name+".incomplete")
    if partial.exists():
        raise ValueError("Incomplete ZIP exists; inspect it before retrying")
    manifest = {"format":FORMAT,"createdUtc":datetime.now(timezone.utc).isoformat(),
                "source":"local-work-data-only","files":[],"noCentralUpload":True}
    try:
        with tempfile.TemporaryDirectory(prefix="kbw-instance-snapshot-") as folder:
            temp = Path(folder)
            snapshots = {}
            for db in (*DBS, *(x for x in OPTIONAL_DBS if (root/x).is_file())):
                snapshots[db] = temp / db
                sqlite_snapshot(root / db, snapshots[db])
            with zipfile.ZipFile(partial,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=4,allowZip64=True) as zipout:
                archive_names = set()
                for rel,p in selected:
                    effective = snapshots.get(rel,p)
                    sidecar = rel.endswith(':Zone.Identifier')
                    stored = rel[:-len(':Zone.Identifier')] + '.kbw-zone-identifier-sidecar' if sidecar else rel
                    if stored in archive_names:
                        raise ValueError('Archive path collision: '+stored)
                    archive_names.add(stored)
                    zipout.write(effective,arcname=stored)
                    row = {"path":stored,"size":effective.stat().st_size,"sha256":sha(effective)}
                    if sidecar:
                        row['originalPath'] = rel
                    manifest["files"].append(row)
                zipout.writestr(MANIFEST,json.dumps(manifest,sort_keys=True,indent=2))
        # Refuse success if new content appeared, was deleted or changed while copying.
        after = files(root)
        if {rel:sha(p) for rel,p in after} != baseline:
            raise RuntimeError("Instance changed during backup; archive discarded")
        inspect(partial)
        os.replace(partial,dest)
        return {"verified":True,"files":len(selected),"archiveBytes":dest.stat().st_size,
                "source":"external-local-data","serverContacted":False}
    except BaseException:
        partial.unlink(missing_ok=True)
        raise

def inspect(archive: Path) -> dict:
    archive = Path(archive).resolve()
    with zipfile.ZipFile(archive,"r") as incoming:
        manifest = json.loads(incoming.read(MANIFEST))
        if manifest.get("format") != FORMAT:
            raise ValueError("Not an external instance backup")
        rows = manifest.get("files")
        if not isinstance(rows,list):
            raise ValueError("Invalid manifest")
        names = [r.get("path") for r in rows]
        if len(names) != len(set(names)) or not REQUIRED.issubset(set(names)):
            raise ValueError("Incomplete/duplicate instance entries")
        originals = [row.get('originalPath',row['path']) for row in rows]
        if len(originals) != len(set(originals)):
            raise ValueError('Duplicate original paths')
        if set(incoming.namelist()) != (set(names) | {MANIFEST}):
            raise ValueError("Extra/unlisted ZIP entry")
        for row in rows:
            rel = row["path"]
            if not safe_rel(rel):
                raise ValueError("Unsafe path")
            original = row.get('originalPath')
            if original is not None and (not isinstance(original,str)
                  or not original.endswith(':Zone.Identifier')
                  or original[:-len(':Zone.Identifier')] + '.kbw-zone-identifier-sidecar' != rel
                  or not safe_rel(original[:-len(':Zone.Identifier')])):
                raise ValueError('Invalid Windows sidecar mapping')
            with incoming.open(rel) as stream:
                h=hashlib.sha256()
                count=0
                for data in iter(lambda:stream.read(1024*1024),b""):
                    h.update(data);count+=len(data)
            if count != row["size"] or h.hexdigest() != row["sha256"]:
                raise ValueError("Backup checksum mismatch")
    return {"verified":True,"files":len(rows),"format":FORMAT}

def restore(archive: Path, target: Path) -> dict:
    info = inspect(archive)
    target = resolve(target,exists=False)
    if target.exists():
        raise ValueError("Refusing to restore into existing directory")
    if not target.parent.exists() or target.parent.is_symlink():
        raise ValueError("Missing or unsafe destination parent")
    target.mkdir(mode=0o700)
    # Own the fresh directory; fail without deleting artifacts on partial error.
    with zipfile.ZipFile(archive,"r") as incoming:
        manifest=json.loads(incoming.read(MANIFEST))
        for row in manifest['files']:
            name=row['path']
            destination=target/row.get('originalPath',name)
            destination.parent.mkdir(parents=True,exist_ok=True)
            if destination.exists() or destination.is_symlink():
                raise ValueError("Restore collision")
            fd=os.open(destination,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600)
            with os.fdopen(fd,"wb") as output, incoming.open(name) as data:
                while chunk:=data.read(1024*1024):
                    output.write(chunk)
    # ZIP archives omit empty directories. The standard Work initializer
    # creates these even if the user has not yet added a single material.
    for rel in ("library/Projects", "library/General", "library/Shared",
                "content/work-hub/media", "content/work-hub/notes",
                "agents/private/skills", "config", "logs", "cache"):
        (target / rel).mkdir(parents=True, exist_ok=True)
    verified = instance_verify(target)
    for rel in OPTIONAL_DBS:
        optional_db=target/rel
        if optional_db.exists():
            with sqlite3.connect(optional_db) as connection:
                if connection.execute("PRAGMA integrity_check").fetchone()[0]!="ok" or connection.execute("PRAGMA foreign_key_check").fetchall():
                    raise ValueError("Restored AI Resource Registry invalid")
    if not verified["ready"]:
        raise ValueError("Restored instance invalid")
    return {"restored":True,"files":info["files"],"target":str(target),
            "noExistingDataOverwritten":True}

def main() -> int:
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("action",choices=("create","verify","restore"))
    p.add_argument("--root",type=Path)
    p.add_argument("--archive",type=Path)
    p.add_argument("--to",type=Path)
    p.add_argument("--quiescent",action="store_true")
    a=p.parse_args()
    try:
        if a.action=="create":
            if not a.root or not a.to: p.error("create requires --root and --to")
            result=create(a.root,a.to,quiescent=a.quiescent)
        elif a.action=="verify":
            if not a.archive: p.error("verify requires --archive")
            result=inspect(a.archive)
        else:
            if not a.archive or not a.to: p.error("restore requires --archive and --to")
            result=restore(a.archive,a.to)
        print(json.dumps(result,ensure_ascii=False,indent=2))
        return 0
    except (OSError,ValueError,sqlite3.Error,RuntimeError,zipfile.BadZipFile) as error:
        print("External instance backup refused: "+str(error),file=sys.stderr)
        return 2

if __name__=="__main__":
    raise SystemExit(main())
