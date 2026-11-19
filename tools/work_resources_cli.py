"""AI Resources Hub local operator/Agent CLI (non-privileged operations only).

All publish, human-approval and real-execution commands are deliberately absent.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys

import work_resource_api as api
import work_resources as store

def main(argv=None) -> int:
    parser=argparse.ArgumentParser(prog="kbw-resources",description=__doc__)
    sub=parser.add_subparsers(dest="action",required=True)
    list_p=sub.add_parser("list");list_p.add_argument("--type",default="");list_p.add_argument("--query",default="")
    show=sub.add_parser("show");show.add_argument("resource_id")
    version=sub.add_parser("version");version.add_argument("version_id")
    create=sub.add_parser("create-draft");create.add_argument("--type",required=True,choices=sorted(store.TYPES));create.add_argument("--name",required=True)
    edit=sub.add_parser("update-draft");edit.add_argument("resource_id");edit.add_argument("--revision",type=int,required=True);edit.add_argument("--files-json",required=True)
    verify=sub.add_parser("validate");verify.add_argument("resource_id")
    submit=sub.add_parser("submit-review");submit.add_argument("resource_id");submit.add_argument("--revision",type=int,required=True)
    imports=sub.add_parser("import-preview");imports.add_argument("--source-type",choices=["url","local"],required=True);imports.add_argument("--source",required=True)
    sub.add_parser("reviews")
    sub.add_parser("installed")
    sub.add_parser("common")
    sub.add_parser("capabilities")
    args=parser.parse_args(argv)
    try:
        command=args.action
        if command=="list":
            data=api.handle("GET",{"view":["list"],"q":[args.query],"type":[args.type]})
        elif command=="show":
            data=store.detail(args.resource_id)
        elif command=="version":
            data=store.version_detail(args.version_id)
        elif command=="create-draft":
            data=api.handle("POST",{},{"action":"create-draft","type":args.type,"name":args.name})
        elif command=="update-draft":
            data=api.handle("POST",{},{"action":"update-draft","resourceId":args.resource_id,
                                     "baseRevision":args.revision,"files":json.loads(Path(args.files_json).read_text())})
        elif command=="validate":
            data=api.handle("POST",{},{"action":"validate","resourceId":args.resource_id})
        elif command=="submit-review":
            data=api.handle("POST",{},{"action":"snapshot","resourceId":args.resource_id,
                                     "baseRevision":args.revision})
        elif command=="import-preview":
            data=api.handle("POST",{},{"action":"import-preview","sourceType":args.source_type,"source":args.source})
        else:
            data=api.handle("GET",{"view":[{"installed":"deployments"}.get(command,command)]})
        print(json.dumps(data,ensure_ascii=False,indent=2))
        return 0
    except (ValueError,OSError,json.JSONDecodeError) as exc:
        status,payload=api.error(exc)
        print(json.dumps({"status":status,**payload}),file=sys.stderr)
        return 2

if __name__=="__main__":
    raise SystemExit(main())
