"""Opt-in local stdio MCP bridge for AI Resources Hub.

No network listener. Deliberately excludes human approvals, installs, secrets,
script execution and Common publishing. Protocol tools are scoped to local data.
"""
from __future__ import annotations
import json
import os
import re
import sys

import work_resource_api as api
import work_resources as store

TOOLS=[
    {"name":"resources_search","description":"Search available local Private resources.",
     "inputSchema":{"type":"object","properties":{"query":{"type":"string"},"type":{"type":"string"}}}},
    {"name":"resources_get","description":"Get one authorized resource and its version summary.",
     "inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}},
    {"name":"resources_get_version","description":"Read one authorized immutable resource version for Agent use.",
     "inputSchema":{"type":"object","properties":{"id":{"type":"string"}},"required":["id"]}},
    {"name":"resources_create_draft","description":"Create a private resource draft; never publishes or installs.",
     "inputSchema":{"type":"object","properties":{"type":{"type":"string","enum":["skill","prompt","mcp","agent"]},
       "name":{"type":"string"},"description":{"type":"string"}},"required":["type","name"]}},
    {"name":"resources_validate","description":"Static checks only. No test scripts or MCP processes run.",
     "inputSchema":{"type":"object","properties":{"resourceId":{"type":"string"}},"required":["resourceId"]}},
    {"name":"resources_submit_review","description":"Snapshot saved draft for human review. Does not approve.",
     "inputSchema":{"type":"object","properties":{"resourceId":{"type":"string"},
       "baseRevision":{"type":"integer"}},"required":["resourceId","baseRevision"]}},
]
ALLOWED={x["name"] for x in TOOLS}
_SESSION_CREATED=set()

def _allowed_ids():
    # Explicit opt-in, process-local delegation. A fresh MCP process sees no
    # existing Private resource by default. CLI/UI remain unaffected.
    raw=os.environ.get("KB_WORK_RESOURCE_AGENT_ALLOWED_IDS","")
    ids=[v.strip() for v in raw.split(",") if v.strip()]
    if len(ids)>100 or any(not re.fullmatch(r"[0-9a-f]{32}",v) for v in ids):
        return set(_SESSION_CREATED)
    return set(ids)|_SESSION_CREATED

def _guard(resource_id):
    if not isinstance(resource_id,str) or resource_id not in _allowed_ids():
        raise store.ResourceError("agent_resource_scope_denied",403)
    return resource_id

def _execute(name,args):
    if name=="resources_search":
        return [r for r in api.handle("GET",{"view":["list"],"q":[args.get("query","")],"type":[args.get("type","")]}) if r["id"] in _allowed_ids()]
    if name=="resources_get":
        return api.handle("GET",{"view":["detail"],"id":[_guard(args.get("id"))]})
    if name=="resources_get_version":
        version=api.handle("GET",{"view":["version"],"id":[args.get("id","")]})
        _guard(version["resource_id"])
        return version
    if name=="resources_create_draft":
        draft=api.handle("POST",{},{"action":"create-draft",**{k:args[k] for k in ("type","name","description") if k in args}})
        _SESSION_CREATED.add(draft["id"])
        return draft
    if name=="resources_validate":
        return api.handle("POST",{},{"action":"validate","resourceId":_guard(args.get("resourceId"))})
    if name=="resources_submit_review":
        return api.handle("POST",{},{"action":"snapshot","resourceId":_guard(args.get("resourceId")),
                                     "baseRevision":args.get("baseRevision")})
    raise ValueError("Unsupported MCP resource operation")

def dispatch(req):
    method=req.get("method")
    if method=="initialize":
        return {"protocolVersion":"2025-06-18","capabilities":{"tools":{"listChanged":False}},
                "serverInfo":{"name":"kb-work-ai-resources-local","version":"0.1.0"}}
    if method=="ping":
        return {}
    if method=="tools/list":
        return {"tools":TOOLS}
    if method=="tools/call":
        params=req.get("params") or {}
        name=params.get("name")
        args=params.get("arguments") or {}
        if name not in ALLOWED or not isinstance(args,dict):
            raise ValueError("Tool not available")
        result=_execute(name,args)
        return {"content":[{"type":"text","text":json.dumps(result,ensure_ascii=False)}],"isError":False}
    raise ValueError("Method not available")

def main():
    # Each stdio MCP message is one UTF-8 JSON-RPC object per line.
    for line in sys.stdin:
        try:
            message=json.loads(line)
            if not isinstance(message,dict):
                continue
            if "id" not in message:
                continue
            reply={"jsonrpc":"2.0","id":message["id"]}
            try:
                reply["result"]=dispatch(message)
            except (ValueError,TypeError,KeyError,OSError) as exc:
                status,payload=api.error(exc)
                reply["error"]={"code":-32000 if status>=500 else -32602,
                                "message":payload["code"]}
            sys.stdout.write(json.dumps(reply,ensure_ascii=False,separators=(",",":"))+"\n")
            sys.stdout.flush()
        except (ValueError,TypeError):
            # Never dump untrusted request bodies or potential secrets to stderr.
            continue

if __name__=="__main__":
    main()
