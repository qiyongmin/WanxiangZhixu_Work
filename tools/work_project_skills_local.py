"""Edit existing local Project Skills in place, never publish them.

The original SKILL.md and references remain authoritative. Writes are CAS
guarded, atomic, backed up under local Resource Data Root and never dispatched
to agents or a Central Portal. No files move during indexing.
"""
from __future__ import annotations
import hashlib
import json
import os
import sqlite3
from pathlib import Path, PurePosixPath
import tempfile

import project_skills
import work_resources as store

MAX_EDIT_BYTES = 750_000
EDIT_SUFFIXES = {".md", ".json", ".txt"}

def _base():
    # Separate external instances cannot see checkout-local employee skills.
    return project_skills.EXTERNAL_DATA or project_skills.ROOT

def _source(skill_id):
    if not isinstance(skill_id, str) or not 1 <= len(skill_id) <= 128:
        raise store.ResourceError("invalid_project_skill_id")
    catalog = project_skills.registry()["skills"]
    match = next((x for x in catalog if x["id"] == skill_id), None)
    if match is None:
        raise store.ResourceError("project_skill_not_found", 404)
    root = _base()
    relative = PurePosixPath(match["path"])
    if ".." in relative.parts or not relative.parts or relative.name != "SKILL.md":
        raise store.ResourceError("unsafe_project_skill_path", 403)
    allowed = ("agents", "private", "skills") if project_skills.EXTERNAL_DATA else (".agents", "skills")
    if tuple(relative.parts[:len(allowed)]) != allowed:
        raise store.ResourceError("unsafe_project_skill_path", 403)
    source = root.joinpath(*relative.parts)
    if not source.is_file() or any(p.is_symlink() for p in (source, *source.parents) if root in p.parents):
        raise store.ResourceError("unsafe_project_skill_source", 403)
    return source, match

def _file(skill_id, relative):
    source, metadata = _source(skill_id)
    if not isinstance(relative, str) or len(relative) > 220 or "\\" in relative:
        raise store.ResourceError("invalid_project_skill_file")
    parts = PurePosixPath(relative).parts
    if not parts or relative.startswith("/") or any(p in ("..", ".") for p in relative.split("/")):
        raise store.ResourceError("invalid_project_skill_file")
    if relative != "SKILL.md" and (parts[0] != "references" or len(parts) != 2
         or PurePosixPath(relative).suffix.lower() not in EDIT_SUFFIXES):
        raise store.ResourceError("invalid_project_skill_file")
    target = source.parent.joinpath(*parts)
    if not target.is_file() or target.is_symlink() or target.parent.is_symlink() or target.stat().st_size > MAX_EDIT_BYTES:
        raise store.ResourceError("project_skill_file_unavailable", 404)
    return target, metadata

def _hash(content):
    return hashlib.sha256(content).hexdigest()

def _files(skill_id):
    source, _ = _source(skill_id)
    files = [source]
    refs = source.parent / "references"
    if refs.is_dir() and not refs.is_symlink():
        files.extend(p for p in refs.iterdir()
          if p.is_file() and not p.is_symlink() and p.suffix.lower() in EDIT_SUFFIXES
             and p.stat().st_size <= MAX_EDIT_BYTES)
    return sorted(files, key=lambda p: (p.name != "SKILL.md", p.name))

def detail(skill_id):
    source, metadata = _source(skill_id)
    files = []
    for path in _files(skill_id):
        raw = path.read_bytes()
        files.append({"path":path.relative_to(source.parent).as_posix(),
                      "sha256":_hash(raw),"size":len(raw)})
    return {"id":skill_id,"name":metadata["name"],"description":metadata["description"],
            "status":metadata["status"],"scope":metadata["scope"],"triggers":metadata["triggers"],
            "aliases":metadata["aliases"],"files":files,"localOnly":True,
            "editable":True,"authoritative":"original-project-skill"}

def read(skill_id, relative):
    path, _ = _file(skill_id,relative)
    raw = path.read_bytes()
    try: content=raw.decode("utf-8")
    except UnicodeError: raise store.ResourceError("project_skill_not_utf8",422) from None
    return {"id":skill_id,"path":relative,"sha256":_hash(raw),"content":content}

def update(body):
    skill_id = body.get("skillId")
    relative = body.get("filePath")
    expected = body.get("expectedSha256")
    content = body.get("content")
    if body.get("confirmation") != "Save this local Project Skill":
        raise store.ResourceError("explicit_skill_save_confirmation_required",403)
    if not isinstance(expected,str) or len(expected)!=64:
        raise store.ResourceError("project_skill_hash_required",409)
    if not isinstance(content,str) or len(content.encode("utf-8"))>MAX_EDIT_BYTES:
        raise store.ResourceError("invalid_project_skill_content")
    path, old_metadata = _file(skill_id,relative)
    if relative == "SKILL.md":
        # The validator must see a complete temporary file. Never rewrite stable
        # ID or broaden the old scope while editing: separate explicit migration.
        with tempfile.TemporaryDirectory(prefix="kbw-skill-validate-") as folder:
            draft=Path(folder)/"SKILL.md"
            draft.write_text(content,encoding="utf-8")
            try: parsed=project_skills.frontmatter(draft)
            except (ValueError, KeyError) as exc:
                raise store.ResourceError("invalid_project_skill_frontmatter",422) from exc
        if parsed["id"]!=skill_id or parsed["scope"]!=old_metadata["scope"]:
            raise store.ResourceError("project_skill_identity_or_scope_change",409)
    if relative.endswith(".json"):
        try: json.loads(content)
        except ValueError as exc: raise store.ResourceError("invalid_project_skill_json",422) from exc
    previous=path.read_bytes()
    if _hash(previous)!=expected:
        raise store.ResourceError("project_skill_revision_conflict",409)
    new=content.encode("utf-8")
    if previous==new:
        return {"saved":True,"unchanged":True,"sha256":expected}
    # Snapshot never lives under Git. The Work instance backup includes this
    # folder in content/ai-resources, together with the original checkout-local
    # Skill archive.
    backup=store.root()/"project-skill-backups"/hashlib.sha256(skill_id.encode()).hexdigest()[:20]
    backup.mkdir(parents=True,exist_ok=True,mode=0o700)
    reference=hashlib.sha256(relative.encode()).hexdigest()[:16]
    archive=backup/(reference+"-"+expected+".bak")
    if not archive.exists():
        fd=os.open(archive,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600)
        with os.fdopen(fd,"wb") as stream:stream.write(previous)
    fd,name=tempfile.mkstemp(prefix=".kbw-skill-",dir=path.parent)
    try:
        with os.fdopen(fd,"wb") as stream:
            stream.write(new)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(name,0o600)
        if path.is_symlink() or _hash(path.read_bytes())!=expected:
            raise store.ResourceError("project_skill_revision_conflict",409)
        os.replace(name,path)
    finally:
        if os.path.exists(name):os.unlink(name)
    # Rebuild generated metadata in-place without adding it to Git.
    # A failed rebuild never rolls back the successfully saved source.
    try:
        project_skills.INDEX.parent.mkdir(parents=True,exist_ok=True)
        project_skills.PUBLIC_CATALOG.parent.mkdir(parents=True,exist_ok=True)
        project_skills.INDEX.write_text(project_skills.serialized(),encoding="utf-8")
        project_skills.PUBLIC_CATALOG.write_text(project_skills.public_serialized(),encoding="utf-8")
    except (OSError,ValueError):
        pass
    # Preserve an audit event in the same private local Resource Registry.
    # The HTTP/CLI entrypoint is not authenticated Agent identity; do not
    # invent one. Logging failure must not falsely report the file as unsaved.
    recorded=False
    try:
        with store._db() as db:
            store._audit(db,"project_skill_updated","project:"+skill_id,
                detail=relative+" · "+expected[:12]+" → "+_hash(new)[:12]+" · local API")
        recorded=True
    except (OSError, ValueError, sqlite3.Error):
        pass
    return {"saved":True,"unchanged":False,"sha256":_hash(new),
            "backupHash":expected,"localOnly":True,"activityRecorded":recorded}
