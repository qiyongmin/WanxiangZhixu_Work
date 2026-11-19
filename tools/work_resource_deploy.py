"""Explicit, copy-based WSL Skill installer; never executes imported content.

All mutations require an approved immutable version and a user confirmation.
An installation receipt is separate from the external Agent directory.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import uuid

import work_resources as store

AGENTS={
    "codex":(".agents","skills"),
    "claude-code":(".claude","skills"),
    "cursor":(".cursor","skills"),
    "opencode":(".opencode","skills"),
}
GLOBAL={
    "codex":(".agents","skills"),
    "claude-code":(".claude","skills"),
    "cursor":(".cursor","skills"),
    "opencode":(".config","opencode","skills"),
}

def _folder_hash(folder):
    if not folder.exists():
        return None
    if folder.is_symlink() or not folder.is_dir():
        raise store.ResourceError("unsafe_target",403)
    files={}
    for item in sorted(folder.rglob("*")):
        if item.is_symlink():
            raise store.ResourceError("target_symlink_rejected",403)
        if item.is_file():
            files[item.relative_to(folder).as_posix()]=hashlib.sha256(item.read_bytes()).hexdigest()
    return hashlib.sha256(json.dumps(files,sort_keys=True).encode()).hexdigest()

def _locate(agent,scope,project_root=None):
    if agent not in AGENTS or scope not in ("global","project"):
        raise store.ResourceError("invalid_agent_or_scope")
    if scope=="global":
        base=Path.home()
        parts=GLOBAL[agent]
    else:
        if not isinstance(project_root,str) or not project_root.startswith("/"):
            raise store.ResourceError("project_root_required")
        base=Path(project_root)
        parts=AGENTS[agent]
    if not base.is_dir() or base.stat().st_uid!=os.getuid() or any(p.is_symlink() for p in (base,*base.parents)):
        raise store.ResourceError("unsafe_target_root",403)
    # Keep KB_Site completely out of scope.
    personal=store.ROOT.parent / "KB_Site"
    if base == personal or personal in base.parents:
        raise store.ResourceError("personal_site_forbidden",403)
    if any(x in ("..",".") for x in base.parts) or str(base).startswith("/mnt/"):
        raise store.ResourceError("unsafe_target_root",403)
    result=base
    for part in parts:
        result=result/part
        if result.is_symlink() or (result.exists() and (not result.is_dir() or result.stat().st_uid!=os.getuid())):
            raise store.ResourceError("target_path_unsafe",403)
    return result

def _skill_slug(version):
    raw=version["files"].get("SKILL.md","")
    if not isinstance(raw,str):
        raise store.ResourceError("skill_md_invalid")
    name=""
    for line in raw.splitlines()[:35]:
        if line.startswith("name:"):
            name=line[5:].strip().strip('"\'')
            break
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,63}",name):
        raise store.ResourceError("invalid_skill_directory_name")
    return name

def preview(body):
    version=store.version_detail(body.get("versionId"), True)
    with store._db() as db:
        resource=db.execute("SELECT type FROM resources WHERE id=?", (version["resource_id"],)).fetchone()
    if not resource or resource["type"]!="skill":
        raise store.ResourceError("native_deployment_not_supported",422)
    if version["review_state"]!="approved":
        raise store.ResourceError("review_required",409)
    agent,scope=body.get("agent"),body.get("scope")
    parent=_locate(agent,scope,body.get("projectRoot"))
    slug=body.get("installAs") or _skill_slug(version)
    if not isinstance(slug,str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}",slug):
        raise store.ResourceError("invalid_install_name")
    target=parent/slug
    if target.is_symlink():
        raise store.ResourceError("target_symlink_rejected",403)
    existing=_folder_hash(target)
    return {"resourceId":version["resource_id"],"versionId":version["id"],
            "agent":agent,"scope":scope,"target":str(target),
            "existingHash":existing,"conflict":existing is not None,
            "requestedHash":version["sha256"],"risk":version["risk"],
            "requiresConfirmation":True,"executesCode":False}

def install(body):
    plan=preview(body)
    if body.get("confirmation")!="Install this reviewed version":
        raise store.ResourceError("explicit_install_confirmation_required",403)
    if body.get("expectedTargetHash","__missing__")!=plan["existingHash"]:
        raise store.ResourceError("target_drifted",409)
    if plan["conflict"] and body.get("onConflict")!="replace":
        raise store.ResourceError("target_conflict",409)
    version=store.version_detail(plan["versionId"])
    target=Path(plan["target"])
    target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    if target.parent.is_symlink():
        raise store.ResourceError("unsafe_target",403)
    txn_id=uuid.uuid4().hex
    backup=store.root()/"transactions"/txn_id/"previous"
    staging=Path(tempfile.mkdtemp(prefix=".kbw-install-",dir=str(target.parent)))
    moved=False
    installed=False
    try:
        for rel,content in version["files"].items():
            dst=staging/rel
            dst.parent.mkdir(parents=True,exist_ok=True)
            raw=store._bytes(content)
            with dst.open("xb") as out:
                out.write(raw)
            os.chmod(dst,0o600)
        # Second check before mutating any destination.
        if _folder_hash(target)!=plan["existingHash"]:
            raise store.ResourceError("target_drifted",409)
        if target.exists():
            backup.parent.mkdir(parents=True,exist_ok=True)
            os.replace(target,backup)
            moved=True
        os.replace(staging,target)
        installed=True
        installed_hash=_folder_hash(target)
        with store._db() as db:
            db.execute("INSERT INTO deployments VALUES(?,?,?,?,?,?,?,?,?)",
                (txn_id,plan["resourceId"],plan["versionId"],plan["agent"],plan["scope"],
                 str(target),installed_hash,"installed",store.now()))
            store._audit(db,"installed",plan["resourceId"],plan["versionId"],
                         "Target agent: "+plan["agent"]+"; scope: "+plan["scope"])
        return {"deploymentId":txn_id,"target":str(target),"installedHash":installed_hash,
                "status":"installed","noExecutionPerformed":True}
    except BaseException:
        if installed and target.exists():
            shutil.rmtree(target)
        if moved and backup.exists():
            os.replace(backup,target)
        raise
    finally:
        if staging.exists():
            shutil.rmtree(staging)

def deployments():
    with store._db() as db:
        rows=[dict(r) for r in db.execute(
            "SELECT * FROM deployments ORDER BY created DESC LIMIT 200")]
    for r in rows:
        try:
            r["actualHash"]=_folder_hash(Path(r["target"]))
            r["drifted"]=r["actualHash"]!=r["installed_hash"]
        except (OSError,store.ResourceError):
            r["actualHash"]=None
            r["drifted"]=True
    return rows

def rollback(body):
    deployment_id=store._id(body.get("deploymentId"))
    if body.get("confirmation")!="Rollback this deployment":
        raise store.ResourceError("explicit_rollback_confirmation_required",403)
    with store._db() as db:
        row=db.execute("SELECT * FROM deployments WHERE id=?", (deployment_id,)).fetchone()
        if not row:
            raise store.ResourceError("deployment_not_found",404)
        receipt=dict(row)
    if receipt["state"]!="installed":
        raise store.ResourceError("deployment_not_active",409)
    target=Path(receipt["target"])
    if _folder_hash(target)!=receipt["installed_hash"]:
        raise store.ResourceError("target_drifted",409)
    # Restoration can only replace content written by the matching transaction.
    backup=store.root()/"transactions"/deployment_id/"previous"
    removed=store.root()/"transactions"/deployment_id/"removed"
    if removed.exists() or removed.is_symlink():
        raise store.ResourceError("transaction_collision",409)
    removed.parent.mkdir(parents=True,exist_ok=True)
    os.replace(target,removed)
    try:
        if backup.exists():
            os.replace(backup,target)
        with store._db() as db:
            db.execute("UPDATE deployments SET state='rolled_back' WHERE id=? AND state='installed'",(deployment_id,))
            store._audit(db,"deployment_rolled_back",receipt["resource_id"],receipt["version_id"])
    except BaseException:
        if not target.exists() and removed.exists():
            os.replace(removed,target)
        raise
    return {"deploymentId":deployment_id,"state":"rolled_back","restoredPrevious":target.exists()}
