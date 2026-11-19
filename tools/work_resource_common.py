"""Offline Common Candidate packaging; never commits, pushes or creates an MR.

Only reviewed, explicit-license versions may be exported into the Private
Data Root. Human GitLab merge and independent high-risk review remain mandatory.
"""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile

import work_resources as store

ALLOWED_LICENSES={"MIT","Apache-2.0","BSD-3-Clause","CC-BY-4.0","company-approved-internal"}

def preview(version_id):
    version=store.version_detail(version_id,True)
    if version["review_state"]!="approved":
        raise store.ResourceError("approved_version_required",409)
    with store._db() as db:
        resource=db.execute("SELECT id,type,name,visibility FROM resources WHERE id=?", (version["resource_id"],)).fetchone()
        if not resource:
            raise store.ResourceError("resource_not_found",404)
        entry=dict(resource)
    license_id=version["source"].get("license","")
    blockers=[]
    if license_id not in ALLOWED_LICENSES:
        blockers.append("explicit_license_review_required")
    # Static checks are advisory generally, but secrets cannot enter Common.
    if any(x["rule"]=="possible_embedded_secret" for x in version["findings"]):
        blockers.append("possible_embedded_secret")
    files=version["files"]
    if any(re.search(r"(?i)(company-only|confidential|internal-only|personal)",path)
           for path in files):
        blockers.append("sensitive_filename_review_required")
    if len(files)>store.MAX_FILES:
        blockers.append("file_count_exceeded")
    return {
       "resourceId":version["resource_id"],"versionId":version_id,
       "type":entry["type"],"name":entry["name"],"sourceVisibility":entry["visibility"],
       "version":version["sequence"],"hash":version["sha256"],
       "license":license_id or "UNSPECIFIED","risk":version["risk"],
       "requiresIndependentReview":version["risk"]=="high",
       "blockers":blockers,"eligibleForCandidate":len(blockers)==0,
       "publishedToGitLab":False,"centralDataSent":False,
       "notice":"Candidate packaging is not GitLab approval or publishing."
    }

def prepare(body):
    info=preview(body.get("versionId"))
    if info["blockers"]:
        raise store.ResourceError("common_candidate_blocked",409)
    if body.get("confirmation")!="Prepare local Common candidate":
        raise store.ResourceError("explicit_candidate_confirmation_required",403)
    version=store.version_detail(body["versionId"],True)
    candidate_id=store.uid()
    base=store.root()/"common-candidates"
    base.mkdir(mode=0o700,parents=True,exist_ok=True)
    destination=base/candidate_id
    temporary=Path(tempfile.mkdtemp(prefix=".candidate-",dir=str(base)))
    try:
        snapshot=temporary/"package"
        snapshot.mkdir(mode=0o700)
        for rel,content in version["files"].items():
            store._clean_path(rel)
            path=snapshot/rel
            path.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
            raw=store._bytes(content)
            with path.open("xb") as output:
                output.write(raw)
            os.chmod(path,0o600)
        manifest={
          "format":"kb-work-common-candidate-v1","candidateId":candidate_id,
          "resourceId":info["resourceId"],"versionId":version["id"],
          "type":info["type"],"name":info["name"],
          "version":info["version"],"sha256":info["hash"],
          "license":info["license"],"risk":info["risk"],
          "requiresIndependentReview":info["requiresIndependentReview"],
          "approvalNotFinal":True,"mustUseGitLabMR":True,
          "files":version["manifest"]
        }
        (temporary/"manifest.json").write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+"\n")
        os.chmod(temporary/"manifest.json",0o600)
        os.replace(temporary,destination)
        with store._db() as db:
            store._audit(db,"common_candidate_prepared",info["resourceId"],version["id"],
                         "Candidate created locally; GitLab MR remains manual")
        return {"candidateId":candidate_id,"path":str(destination),
                "gitlabPublished":False,"requiresIndependentReview":info["requiresIndependentReview"]}
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
