"""Local-first AI Resources Hub: private registry and immutable version store.

Separate from Work Hub SQLite. Never publish or proxy private data centrally.
No downloaded code, script, or MCP server is executed by this module.
"""
from __future__ import annotations
import base64
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import io
import zipfile
import json
import os
from pathlib import Path, PurePosixPath
import re
import sqlite3
import stat
import uuid

ROOT = Path(__file__).resolve().parents[1]
TYPES = {"skill", "prompt", "mcp", "agent"}
KINDS = {"draft", "pending", "approved", "rejected"}
MAX_FILES = 128
MAX_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024

class ResourceError(ValueError):
    def __init__(self, code: str, status: int = 400):
        super().__init__(code)
        self.code, self.status = code, status

def now():
    return datetime.now(timezone.utc).isoformat()

def uid():
    return uuid.uuid4().hex

def data_root():
    selected = os.environ.get("KB_WORK_DATA_ROOT")
    if selected:
        from work_instance_paths import verify
        verify(selected)
        return Path(selected).resolve()
    return ROOT

def root():
    base = data_root() / "content" / "ai-resources"
    if base.is_symlink():
        raise ResourceError("unsafe_data_root", 403)
    return base

def _connect():
    base = root()
    base.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = base / "registry.sqlite3"
    if path.is_symlink():
        raise ResourceError("unsafe_registry", 403)
    db = sqlite3.connect(str(path), timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=5000")
    db.executescript("""
    CREATE TABLE IF NOT EXISTS resources (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]', visibility TEXT NOT NULL DEFAULT 'private',
      revision INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, updated TEXT NOT NULL,
      CHECK (visibility='private')
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL UNIQUE REFERENCES resources(id),
      revision INTEGER NOT NULL, files TEXT NOT NULL, source TEXT NOT NULL DEFAULT '{}',
      base_version TEXT, updated TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS versions (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id),
      sequence INTEGER NOT NULL, sha256 TEXT NOT NULL, manifest TEXT NOT NULL,
      source TEXT NOT NULL, risk TEXT NOT NULL, findings TEXT NOT NULL,
      review_state TEXT NOT NULL DEFAULT 'pending', created TEXT NOT NULL,
      UNIQUE(resource_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY, version_id TEXT NOT NULL REFERENCES versions(id),
      actor TEXT NOT NULL, decision TEXT NOT NULL, evidence TEXT NOT NULL,
      created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY, resource_id TEXT NOT NULL REFERENCES resources(id),
      version_id TEXT NOT NULL REFERENCES versions(id), agent TEXT NOT NULL,
      scope TEXT NOT NULL, target TEXT NOT NULL, installed_hash TEXT NOT NULL,
      state TEXT NOT NULL, created TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, resource_id TEXT NOT NULL,
      version_id TEXT, detail TEXT NOT NULL, created TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
    CREATE INDEX IF NOT EXISTS idx_versions_resource ON versions(resource_id, sequence);
    """)
    os.chmod(path, 0o600)
    return db

@contextmanager
def _db():
    conn = _connect()
    try:
        with conn:
            yield conn
    finally:
        conn.close()

def _row(r):
    return dict(r) if r is not None else None

def _audit(db, action, resource_id, version_id=None, detail=""):
    db.execute("INSERT INTO activity VALUES(?,?,?,?,?,?)",
               (uid(), action, resource_id, version_id, detail[:500], now()))

def _id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
        raise ResourceError("invalid_id")
    return value

def _clean_path(rel):
    if not isinstance(rel, str) or "\\" in rel or ":" in rel or "\x00" in rel:
        raise ResourceError("invalid_file_path")
    p = PurePosixPath(rel)
    if not rel or rel.startswith("/") or len(rel) > 240 or len(p.parts) > 16 or any(x in ("", ".", "..") for x in rel.split("/")):
        raise ResourceError("invalid_file_path")
    if any(x.startswith(".git") or x in (".env", "node_modules", "__pycache__") for x in p.parts):
        raise ResourceError("disallowed_file_path")
    return rel

def _bytes(data):
    if isinstance(data, str):
        return data.encode("utf-8")
    if isinstance(data, dict) and set(data) == {"base64"} and isinstance(data["base64"], str):
        try:
            return base64.b64decode(data["base64"], validate=True)
        except ValueError:
            raise ResourceError("invalid_base64") from None
    raise ResourceError("invalid_file_content")

def checked_files(files, resource_type):
    if not isinstance(files, dict) or not 0 < len(files) <= MAX_FILES:
        raise ResourceError("invalid_file_count")
    actual, total = {}, 0
    for path, body in files.items():
        key = _clean_path(path)
        raw = _bytes(body)
        if len(raw) > MAX_FILE_BYTES:
            raise ResourceError("file_too_large", 413)
        total += len(raw)
        if total > MAX_BYTES:
            raise ResourceError("package_too_large", 413)
        actual[key] = raw
    if resource_type == "skill" and "SKILL.md" not in actual:
        raise ResourceError("skill_md_required")
    return actual

def security_report(resource_type, actual):
    findings, risk = [], "low"
    for path, raw in actual.items():
        text = raw[:200_000].decode("utf-8", errors="replace")
        if re.search(r"(?i)(api[_-]?key|secret|password|token)\s*[:=]\s*['\"]?[a-z0-9_\-/+=]{16,}", text):
            findings.append({"severity":"high","rule":"possible_embedded_secret","file":path})
        if re.search(r"(?i)(curl|wget)\s+[^\n|]+\|\s*(sh|bash)|rm\s+-rf|eval\s*\(", text):
            findings.append({"severity":"high","rule":"dangerous_command_pattern","file":path})
        if path.startswith("scripts/") or path.endswith((".py", ".sh", ".js", ".ts", ".exe")):
            risk = "high"
            findings.append({"severity":"medium","rule":"executable_content","file":path})
        if resource_type == "skill" and path == "SKILL.md" and not text.startswith("---\n"):
            findings.append({"severity":"medium","rule":"nonstandard_skill_frontmatter","file":path})
        if resource_type == "mcp" and path.endswith(".json"):
            try:
                configuration = json.loads(text)
                if not isinstance(configuration, dict):
                    raise ValueError("not an object")
            except ValueError:
                findings.append({"severity":"high","rule":"invalid_mcp_json","file":path})
        if resource_type == "mcp" and ("command" in text or "url" in text):
            risk = "high"
    if resource_type == "mcp":
        risk = "high"  # Installation/activation of an MCP process is a separate approval.
    if any(f["severity"] == "high" for f in findings):
        risk = "high"
    return {"risk": risk, "findings": findings, "noExecutionPerformed": True,
            "safeToExecute": False}

def create_draft(body):
    kind = body.get("type")
    if kind not in TYPES:
        raise ResourceError("invalid_resource_type")
    name = body.get("name", "")
    if not isinstance(name, str) or not 0 < len(name.strip()) <= 120:
        raise ResourceError("invalid_resource_name")
    files = body.get("files")
    if files is None:
        files = ({"SKILL.md":"---\nname: example\ndescription: Describe this skill\n---\n\n# Instructions\n"}
                 if kind == "skill" else
                 {"config.json":"{}"} if kind == "mcp" else
                 {"AGENT.md":"# Agent instructions\n"} if kind == "agent" else
                 {"PROMPT.md":"# Prompt\n"})
    checked_files(files, kind)
    tags = body.get("tags", [])
    if not isinstance(tags, list) or len(tags)>20 or not all(isinstance(t,str) and len(t)<=40 for t in tags):
        raise ResourceError("invalid_tags")
    description = body.get("description", "")
    category = body.get("category", "")
    if not isinstance(description,str) or len(description)>1500 or not isinstance(category,str) or len(category)>100:
        raise ResourceError("invalid_metadata")
    source = body.get("source", {})
    if not isinstance(source,dict) or len(json.dumps(source))>4000:
        raise ResourceError("invalid_source")
    resource_id, draft_id, stamp = uid(),uid(),now()
    with _db() as db:
        db.execute("INSERT INTO resources VALUES(?,?,?,?,?,?,'private',1,?,?)",
                   (resource_id,kind,name.strip(),description,category,json.dumps(tags),stamp,stamp))
        db.execute("INSERT INTO drafts VALUES(?,?,1,? ,?,NULL,?)",
                   (draft_id,resource_id,json.dumps(files),json.dumps(source),stamp))
        _audit(db, "created_draft", resource_id)
    return detail(resource_id)

def detail(resource_id):
    with _db() as db:
        r = _row(db.execute("SELECT * FROM resources WHERE id=?", (_id(resource_id),)).fetchone())
        if not r:
            raise ResourceError("resource_not_found",404)
        r["tags"] = json.loads(r["tags"])
        versions = [_row(row) for row in db.execute(
            "SELECT id,sequence,sha256,risk,review_state,created FROM versions WHERE resource_id=? ORDER BY sequence DESC", (resource_id,))]
        draft = _row(db.execute("SELECT * FROM drafts WHERE resource_id=?", (resource_id,)).fetchone())
        if draft:
            draft["files"]=json.loads(draft["files"])
            draft["source"]=json.loads(draft["source"])
        return {**r, "versions":versions,"draft":draft}

def list_resources(query="",kind="",visibility=""):
    with _db() as db:
        if kind and kind not in TYPES:
            raise ResourceError("invalid_resource_type")
        # Private database only; Common manifests must be explicitly sourced from audited checkout.
        rows=db.execute("""
            SELECT r.*,
              (SELECT v.id FROM versions v WHERE v.resource_id=r.id
               ORDER BY v.sequence DESC LIMIT 1) AS latest_version_id,
              (SELECT v.risk FROM versions v WHERE v.resource_id=r.id
               ORDER BY v.sequence DESC LIMIT 1) AS latest_version_risk,
              (SELECT v.review_state FROM versions v
               WHERE v.resource_id=r.id ORDER BY v.sequence DESC LIMIT 1)
                  AS latest_review_state,
              EXISTS(SELECT 1 FROM drafts d WHERE d.resource_id=r.id) AS draft_exists
            FROM resources r ORDER BY r.updated DESC LIMIT 1000
        """).fetchall()
    found=[]
    for row in rows:
        r=_row(row)
        r["tags"]=json.loads(r["tags"])
        r["latestReviewState"]=r.pop("latest_review_state")
        r["latestVersionId"]=r.pop("latest_version_id")
        r["latestVersionRisk"]=r.pop("latest_version_risk")
        r["hasDraft"]=bool(r.pop("draft_exists"))
        if kind and r["type"]!=kind:
            continue
        if visibility and visibility!="private":
            continue
        if query and query.casefold() not in " ".join([r["name"],r["description"],r["category"],*r["tags"]]).casefold():
            continue
        found.append(r)
    return found[:200]

def update_draft(resource_id, data):
    info=detail(resource_id)
    draft=info["draft"]
    if draft is None:
        raise ResourceError("draft_not_found",404)
    if type(data.get("baseRevision")) is not int or data["baseRevision"] != draft["revision"]:
        raise ResourceError("revision_conflict",409)
    files=data.get("files",draft["files"])
    checked_files(files,info["type"])
    source=data.get("source",draft["source"])
    if not isinstance(source,dict) or len(json.dumps(source))>4000:
        raise ResourceError("invalid_source")
    with _db() as db:
        cursor=db.execute("UPDATE drafts SET files=?,source=?,revision=revision+1,updated=? WHERE id=? AND revision=?",
                    (json.dumps(files),json.dumps(source),now(),draft["id"],draft["revision"]))
        if cursor.rowcount!=1:
            raise ResourceError("revision_conflict",409)
        db.execute("UPDATE resources SET updated=?,revision=revision+1 WHERE id=?", (now(), resource_id))
        _audit(db,"updated_draft",resource_id)
    return detail(resource_id)

def _save_object(raw):
    digest=hashlib.sha256(raw).hexdigest()
    target=root() / "objects" / digest[:2] / digest
    target.parent.mkdir(parents=True,exist_ok=True)
    if target.is_symlink():
        raise ResourceError("unsafe_object_store",403)
    try:
        fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600)
        with os.fdopen(fd,"wb") as fp:
            fp.write(raw)
            fp.flush()
            os.fsync(fp.fileno())
    except FileExistsError:
        if not target.is_file() or target.is_symlink() or hashlib.sha256(target.read_bytes()).hexdigest()!=digest:
            raise ResourceError("object_integrity_error",409)
    return digest

def snapshot(resource_id, data):
    info=detail(resource_id)
    draft=info["draft"]
    if draft is None:
        raise ResourceError("draft_not_found",404)
    if data.get("baseRevision") != draft["revision"]:
        raise ResourceError("revision_conflict",409)
    actual=checked_files(draft["files"],info["type"])
    report=security_report(info["type"],actual)
    manifest={path:{"sha256":_save_object(raw),"size":len(raw)} for path,raw in sorted(actual.items())}
    digest=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()
    with _db() as db:
        db.execute("BEGIN IMMEDIATE")
        current=db.execute("SELECT revision FROM drafts WHERE id=?", (draft["id"],)).fetchone()
        if not current or current["revision"]!=draft["revision"]:
            raise ResourceError("revision_conflict",409)
        seq=db.execute("SELECT COALESCE(MAX(sequence),0)+1 FROM versions WHERE resource_id=?", (resource_id,)).fetchone()[0]
        version_id=uid()
        db.execute("INSERT INTO versions VALUES(?,?,?,?,?,?,?,?,'pending',?)",
                   (version_id,resource_id,seq,digest,json.dumps(manifest),json.dumps(draft["source"]),
                    report["risk"],json.dumps(report["findings"]),now()))
        db.execute("DELETE FROM drafts WHERE id=?", (draft["id"],))
        _audit(db,"snapshotted",resource_id,version_id)
    return {"versionId":version_id,"sequence":seq,"sha256":digest,"security":report}

def version_detail(version_id, include_files=True):
    with _db() as db:
        v=_row(db.execute("SELECT * FROM versions WHERE id=?",(_id(version_id),)).fetchone())
    if not v:
        raise ResourceError("version_not_found",404)
    v["manifest"]=json.loads(v["manifest"])
    v["source"]=json.loads(v["source"])
    v["findings"]=json.loads(v["findings"])
    if include_files:
        files={}
        for path, meta in v["manifest"].items():
            name=meta["sha256"]
            target=root()/"objects"/name[:2]/name
            if target.is_symlink() or not target.is_file():
                raise ResourceError("object_integrity_error",409)
            raw=target.read_bytes()
            if hashlib.sha256(raw).hexdigest()!=name:
                raise ResourceError("object_integrity_error",409)
            try:
                files[path]=raw.decode("utf-8")
            except UnicodeDecodeError:
                files[path]={"base64":base64.b64encode(raw).decode("ascii")}
        v["files"]=files
    return v

def decide(version_id, data):
    choice=data.get("decision")
    if choice not in {"approve","reject"} or data.get("confirmation")!="I reviewed this exact version":
        raise ResourceError("explicit_human_confirmation_required",403)
    actor=data.get("actor")
    if actor!="local-user":
        raise ResourceError("human_review_only",403)
    evidence=data.get("evidence","")
    if not isinstance(evidence,str) or len(evidence)>1000:
        raise ResourceError("invalid_evidence")
    with _db() as db:
        db.execute("BEGIN IMMEDIATE")
        v=db.execute("SELECT resource_id,review_state FROM versions WHERE id=?", (_id(version_id),)).fetchone()
        if not v:
            raise ResourceError("version_not_found",404)
        if v["review_state"]!="pending":
            raise ResourceError("review_already_decided",409)
        db.execute("UPDATE versions SET review_state=? WHERE id=?",
                   ("approved" if choice=="approve" else "rejected",version_id))
        db.execute("INSERT INTO reviews VALUES(?,?,?,?,?,?)", (uid(),version_id,actor,choice,evidence,now()))
        _audit(db,"review_"+choice,v["resource_id"],version_id)
    return version_detail(version_id, False)

def export_zip(version_id):
    """Read-only local export of an immutable resource version (not Common publishing)."""
    item=version_detail(version_id,True)
    out=io.BytesIO()
    with zipfile.ZipFile(out,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=4) as z:
        for rel,blob in sorted(item["files"].items()):
            _clean_path(rel)
            z.writestr("package/"+rel,_bytes(blob))
        z.writestr("resource-manifest.json",json.dumps({
            "format":"kb-work-resource-export-v1",
            "resourceId":item["resource_id"],"versionId":item["id"],
            "sequence":item["sequence"],"sha256":item["sha256"],
            "reviewState":item["review_state"],
            "notice":"Private local export, NOT Common publication or execution authorization",
            "files":item["manifest"]},ensure_ascii=False,indent=2))
    return out.getvalue()

def activity():
    with _db() as db:
        return [_row(r) for r in db.execute("SELECT * FROM activity ORDER BY created DESC LIMIT 100")]

def activity_journal(limit=100, before=""):
    """Local-only, read-only journal with authoritative resource names and origins.

    Existing audits remain immutable. Legacy import events have no recorded
    actor: do not infer a model, Agent, or person from source provenance.
    """
    if type(limit) is not int or limit<1 or limit>250:
        raise ResourceError("invalid_activity_limit")
    args=[]
    where=""
    if before:
        if not isinstance(before,str) or len(before)>130 or "|" not in before:
            raise ResourceError("invalid_activity_cursor")
        timestamp,event_id=before.rsplit("|",1)
        try: datetime.fromisoformat(timestamp)
        except ValueError: raise ResourceError("invalid_activity_cursor") from None
        if not re.fullmatch(r"[a-f0-9]{32}",event_id):
            raise ResourceError("invalid_activity_cursor")
        where="WHERE (a.created < ? OR (a.created = ? AND a.id < ?))"
        args.extend([timestamp,timestamp,event_id])
    with _db() as db:
        rows=db.execute(f"""
          SELECT a.id,a.kind,a.resource_id,a.version_id,a.detail,a.created,
            r.name AS resource_name,r.type AS resource_type,
            COALESCE(
              (SELECT d.source FROM drafts d WHERE d.resource_id=r.id),
              (SELECT v.source FROM versions v WHERE v.resource_id=r.id
                ORDER BY v.sequence DESC LIMIT 1),
              '{{}}') AS source_json,
            (SELECT rev.actor FROM reviews rev WHERE rev.version_id=a.version_id
              ORDER BY rev.created DESC LIMIT 1) AS review_actor
          FROM activity a LEFT JOIN resources r ON r.id=a.resource_id
          {where}
          ORDER BY a.created DESC,a.id DESC LIMIT ?
        """,(*args,limit+1)).fetchall()
    result=[]
    for row in rows[:limit]:
        item=_row(row)
        try: source=json.loads(item.pop("source_json") or "{}")
        except (ValueError,TypeError):source={}
        if not isinstance(source,dict):source={}
        project=item["resource_id"].startswith("project:")
        repository=source.get("repository")
        ref=source.get("ref")
        result.append({
          "id":item["id"],"kind":item["kind"],
          "resourceId":item["resource_id"],"versionId":item["version_id"],
          "name":item["resource_name"] or
            (item["resource_id"][len("project:"):] if project else "Unknown resource"),
          "resourceType":item["resource_type"] or ("skill" if project else "unknown"),
          "sourceRepository":repository[:150] if isinstance(repository,str) else None,
          "sourceRef":ref[:45] if isinstance(ref,str) else None,
          "detail":item["detail"][:500],"createdAt":item["created"],
          "actor":item["review_actor"] if item["kind"].startswith("review_") else None,
          "actorRecorded":bool(item["kind"].startswith("review_") and item["review_actor"]),
          "origin":"project-skill" if project else "ai-resources",
        })
    next_cursor=(
        result[-1]["createdAt"]+"|"+result[-1]["id"]
        if len(rows)>limit and result else None)
    return {"items":result,"nextCursor":next_cursor,"localOnly":True,
            "historicalActorPolicy":"unrecorded-means-unknown"}

def reviews():
    with _db() as db:
        return [_row(r) for r in db.execute("""
          SELECT v.id AS versionId,v.resource_id AS resourceId,r.name AS name,r.type AS type,
          v.sequence AS sequence,v.risk AS risk,v.review_state AS state,v.created AS created,
          v.findings AS findings
          FROM versions v JOIN resources r ON v.resource_id=r.id
          ORDER BY v.created DESC LIMIT 100""")]

def new_draft_from_version(resource_id, version_id):
    info=detail(resource_id)
    if info["draft"] is not None:
        raise ResourceError("draft_already_exists",409)
    v=version_detail(version_id)
    if v["resource_id"]!=resource_id:
        raise ResourceError("version_mismatch",409)
    with _db() as db:
        db.execute("INSERT INTO drafts VALUES(?,?,1,?,?,?,?)",
            (uid(),resource_id,json.dumps(v["files"]),json.dumps(v["source"]),version_id,now()))
        _audit(db,"created_revision_draft",resource_id,version_id)
    return detail(resource_id)
