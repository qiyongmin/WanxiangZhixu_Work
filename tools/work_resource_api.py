"""HTTP-independent adapter for the local-only resource registry.

This module exposes no central/remote route, no script runner, and no secret API.
"""
from __future__ import annotations
import json

import work_resources as store
import work_resource_import as importer
import work_resource_deploy as deployment
import work_skill_layers
import work_resource_common as common
import work_prompt_notebook as prompts
import project_skills
import work_project_skills_local as local_skills

def project_skills_catalog():
    """Return sanitized local metadata only; never copy project Skill content.

    Work Skills remain authoritative in their original Common/Private layer.
    This view is for the localhost Skills UI, never the Central Portal.
    """
    catalog = project_skills.registry()
    items = []
    for item in catalog.get("skills", []):
        identifier = item.get("id", "")
        layer = "local"
        items.append({
            "id": identifier, "name": item.get("name", ""),
            "description": item.get("description", ""),
            "status": item.get("status", "active"),
            "layer": layer, "source": "project-registry",
        })
    return {"skills": items, "localOnly": True, "metadataOnly": True,
            "sharedToCentral": False}

def handle(method, params, body=None):
    body = body or {}
    if method == "GET":
        view = (params.get("view") or ["list"])[0]
        rid = (params.get("id") or [""])[0]
        if view == "prompt-list":
            return prompts.list_prompts((params.get("q") or [""])[0])
        if view == "prompt-detail":
            return prompts.detail(rid)
        if view == "prompt-flows":
            return prompts.flows()
        if view == "project-skills":
            return project_skills_catalog()
        if view == "project-skill-detail":
            return local_skills.detail(rid)
        if view == "project-skill-file":
            return local_skills.read(rid,(params.get("file") or ["SKILL.md"])[0])
        if view == "list":
            return store.list_resources((params.get("q") or [""])[0],
                                        (params.get("type") or [""])[0],
                                        (params.get("visibility") or [""])[0])
        if view == "detail":
            return store.detail(rid)
        if view == "version":
            return store.version_detail(rid)
        if view == "reviews":
            return store.reviews()
        if view == "deployments":
            return deployment.deployments()
        if view == "activity":
            return store.activity()
        if view == "activity-journal":
            try: limit=int((params.get("limit") or ["100"])[0])
            except (ValueError,TypeError): raise store.ResourceError("invalid_activity_limit") from None
            return store.activity_journal(limit,(params.get("before") or [""])[0])
        if view == "common":
            return work_skill_layers.common_registry()
        if view == "capabilities":
            return {"mode":"local-only","resourceTypes":sorted(store.TYPES),
                    "agents":sorted(deployment.AGENTS),
                    "portalWritesEnabled":False,"mcpExecutionEnabled":False,
                    "approvalMode":"inline-local",
                    "realExecutionSandbox":False,
                    "implementedFeatures":["drafts","versions","review","static-validation",
                      "local-source-import","public-github-import","native-skill-install",
                      "agent-conflict-detection","rollback","prompt-notebook","prompt-flows","prompt-steering-export"]}
        raise store.ResourceError("unknown_view",404)
    if method!="POST" or not isinstance(body,dict):
        raise store.ResourceError("invalid_method")
    action=body.get("action")
    if action=="project-skill-save":
        return local_skills.update(body)
    if action=="prompt-create":
        return prompts.create(body)
    if action=="prompt-save":
        return prompts.save(body)
    if action=="prompt-revision":
        return prompts.start_revision(body.get("resourceId"),body.get("versionId"))
    if action=="prompt-favorite":
        return prompts.set_favorite(body.get("resourceId"),body.get("favorite"))
    if action=="prompt-used":
        return prompts.mark_used(body.get("resourceId"))
    if action=="prompt-flow-save":
        return prompts.save_flow(body)
    if action=="prompt-steering-preview":
        return prompts.steering_preview(body)
    if action=="prompt-steering-export":
        return prompts.steering_export(body)
    if action=="create-draft":
        return store.create_draft(body)
    if action=="update-draft":
        return store.update_draft(body.get("resourceId"),body)
    if action=="snapshot":
        return store.snapshot(body.get("resourceId"),body)
    if action=="start-revision":
        return store.new_draft_from_version(body.get("resourceId"),body.get("versionId"))
    if action=="review":
        return store.decide(body.get("versionId"),body)
    if action=="import-preview":
        return importer.preview(body)
    if action=="validate":
        info=store.detail(body.get("resourceId"))
        draft=info.get("draft")
        if not draft:
            raise store.ResourceError("draft_not_found",404)
        return store.security_report(info["type"],store.checked_files(draft["files"],info["type"]))
    if action in ("common-candidate-preview","common-candidate-prepare"):
        raise store.ResourceError("skill_publication_disabled",403)
    if action=="deployment-preview":
        return deployment.preview(body)
    if action=="deploy":
        return deployment.install(body)
    if action=="rollback":
        return deployment.rollback(body)
    raise store.ResourceError("unknown_action",404)

def error(exc):
    if isinstance(exc,store.ResourceError):
        return exc.status,{"ok":False,"code":exc.code,"error":exc.code}
    if isinstance(exc,KeyError):
        return 400,{"ok":False,"code":"missing_field","error":"Required field missing"}
    if isinstance(exc,(ValueError,TypeError)):
        return 400,{"ok":False,"code":"invalid_request","error":"Invalid resource request"}
    return 503,{"ok":False,"code":"resource_service_unavailable","error":"Local resource service unavailable"}
