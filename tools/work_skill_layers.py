#!/usr/bin/env python3
"""Work Skills are local-only instance data, never GitLab source.

Standalone uses its locally ignored .agents directory for legacy compatibility;
external instances use their own independent agents/private/skills directory.
"""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import stat
import sys

import project_skills as legacy
from work_instance_paths import resolve, verify, CODE

COMMON = ()  # Historical generic Skills are local too.
FORMAT = "kb-work-skills-v1"

class SkillBoundaryError(ValueError):
    pass

def item(path: Path, base: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise SkillBoundaryError("Symlink or missing Skill definition")
    data = legacy.frontmatter(path)
    return {"id": data["id"], "name": data["name"], "description": data["description"],
            "status": data["status"], "scope": data["scope"],
            "aliases": data["aliases"], "triggers": data["triggers"],
            "path": path.relative_to(base).as_posix()}

def common_registry() -> dict:
    # Compatibility view: zero Skills are ever published as Common source.
    return {"format": FORMAT, "tier": "common", "skills": []}

def private_registry(root: Path) -> dict:
    root = resolve(root)
    verify(root)
    folder = root / "agents/private/skills"
    result = []
    if folder.exists():
        if folder.is_symlink():
            raise SkillBoundaryError("Private Skills directory cannot be a symlink")
        for definition in sorted(folder.rglob("SKILL.md")):
            if any(p.is_symlink() for p in (definition, *definition.parents) if folder in p.parents or p == folder):
                raise SkillBoundaryError("Symlink in private Skill path")
            result.append(item(definition, root))
    if len({r["id"] for r in result}) != len(result):
        raise SkillBoundaryError("Duplicate private Skill ID")
    return {"format": FORMAT, "tier": "private", "skills": result}

def merge(root: Path) -> dict:
    # Never merge checkout-local Skills into a separate user's Data Root.
    private = private_registry(root)["skills"]
    return {"format": FORMAT, "tier": "local-only", "skills": sorted(
        [{**s, "layer": "local"} for s in private], key=lambda x:x["id"])}

def write_private(root: Path) -> dict:
    root = resolve(root)
    result = private_registry(root)
    # Only private-only metadata is persisted. Never send merged/private data
    # to GitLab or expose this path through an HTTP route.
    path = root / "agents/private/registry.json"
    if path.is_symlink():
        raise SkillBoundaryError("Refusing symlink registry")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise SkillBoundaryError("Existing registry permissions unsafe")
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(result, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return {"privateCount": len(result["skills"]), "localOnly": True}

def audit_common() -> dict:
    registry = common_registry()
    for entry in registry["skills"]:
        for scope in entry["scope"]:
            if scope.startswith(("projects/", "library/", "data/", "/" + "home/", "C:\\", ".agents/skills/work/initiatives/", ".agents/skills/work/line-management/")):
                raise SkillBoundaryError("Common Skill has private project scope")
    return {"passed": True, "commonCount": 0, "privateMetadataIncluded": False}

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("action", choices=("audit-common", "common", "private", "merge", "build-private"))
    p.add_argument("--data-root")
    a = p.parse_args(argv)
    try:
        if a.action in ("audit-common", "common"):
            output = audit_common() if a.action == "audit-common" else common_registry()
        else:
            if not a.data_root:
                p.error("--data-root required for private commands")
            output = {"private": private_registry(Path(a.data_root))} if a.action == "private" else (
                merge(Path(a.data_root)) if a.action == "merge" else write_private(Path(a.data_root)))
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError) as err:
        print("Skill boundary refused: " + str(err), file=sys.stderr)
        return 2

if __name__ == "__main__":
    raise SystemExit(main())
