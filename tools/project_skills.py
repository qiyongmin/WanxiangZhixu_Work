#!/usr/bin/env python3
"""Build, verify and route KB_Site project Skills without external dependencies.

SKILL.md frontmatter is intentionally a small YAML subset: scalar strings
or JSON-compatible single-line lists. The business Skill is authoritative.
"""
import argparse
import fnmatch
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / ".agents" / "skills"
EXTERNAL_DATA = Path(os.environ['KB_WORK_DATA_ROOT']).resolve() if os.environ.get('KB_WORK_DATA_ROOT') else None
# In external mode, generated merged metadata stays strictly in the local
# instance. The common repository never receives Private Skills/Registry.
INDEX = EXTERNAL_DATA / 'agents/merged-local-registry.json' if EXTERNAL_DATA else SKILLS / 'registry.json'
PUBLIC_CATALOG = EXTERNAL_DATA / 'data/project-skills.json' if EXTERNAL_DATA else ROOT / 'data/project-skills.json'
ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$")
VALID_STATUS = {"active", "deprecated", "disabled"}
FIELDS = {"name", "id", "description", "status", "scope", "triggers", "aliases"}
LISTS = {"scope", "triggers", "aliases"}


def frontmatter(path):
    contents = path.read_text(encoding="utf-8")
    chunks = contents.split("---", 2)
    if len(chunks) != 3 or chunks[0].strip():
        raise ValueError(f"{path}: missing frontmatter delimiter")
    values = {}
    for line in chunks[1].strip().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if ":" not in line:
            raise ValueError(f"{path}: unsupported metadata line: {line}")
        key, raw = line.split(":", 1)
        key, raw = key.strip(), raw.strip()
        if key not in FIELDS or key in values:
            raise ValueError(f"{path}: unexpected/repeated field {key}")
        if key in LISTS:
            try:
                value = json.loads(raw)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}: {key} must be a JSON string array") from exc
            if not isinstance(value, list) or not value or not all(isinstance(v, str) and v.strip() for v in value):
                raise ValueError(f"{path}: {key} must be a nonempty string array")
            values[key] = value
        else:
            values[key] = raw.strip("\"'")
    if set(values) != FIELDS:
        raise ValueError(f"{path}: missing fields {sorted(FIELDS-set(values))}")
    if not ID_RE.fullmatch(values["id"]):
        raise ValueError(f"{path}: invalid stable ID")
    if values["status"] not in VALID_STATUS:
        raise ValueError(f"{path}: invalid lifecycle status")
    if "Global Guardrails" not in chunks[2] or "AGENTS.md" not in chunks[2]:
        raise ValueError(f"{path}: missing project Global Guardrails declaration")
    if re.search(r"(?im)^\s*(requires|depends_on|overrides_global)\s*:", chunks[1]):
        raise ValueError(f"{path}: forbidden cross-skill dependency/global override")
    if not chunks[2].strip():
        raise ValueError(f"{path}: empty skill instructions")
    return values


def registry():
    if EXTERNAL_DATA is not None:
        from work_skill_layers import merge
        merged = merge(EXTERNAL_DATA)
        return {'schemaVersion': 1, 'skills': merged['skills']}
    # Original in-checkout standalone behaviour remains fully compatible.
    out = []
    seen = set()
    for path in sorted(SKILLS.rglob("SKILL.md")):
        data = frontmatter(path)
        if data["id"] in seen:
            raise ValueError(f"duplicate ID: {data['id']}")
        seen.add(data["id"])
        out.append({"id": data["id"], "name": data["name"], "description": data["description"],
                    "status": data["status"], "path": path.relative_to(ROOT).as_posix(),
                    "scope": data["scope"], "triggers": data["triggers"], "aliases": data["aliases"]})
    return {"schemaVersion": 1, "skills": sorted(out, key=lambda x: x["id"])}


def serialized():
    return json.dumps(registry(), ensure_ascii=False, indent=2) + "\n"


def dashboard_catalog():
    """Publish selected project Skill documentation; registry remains authoritative."""
    skills = []
    for item in registry()["skills"]:
        source = (EXTERNAL_DATA or ROOT) / item['path']
        body = source.read_text(encoding="utf-8").split("---", 2)[2].strip()
        prompts_path = source.parent / "references" / "prompt-examples.json"
        if prompts_path.exists():
            examples = json.loads(prompts_path.read_text(encoding="utf-8")).get("prompts", [])
            if not isinstance(examples, list) or not examples or not all(isinstance(p, str) and p.strip() for p in examples):
                raise ValueError(f"{prompts_path}: prompts must be nonempty strings")
        else:
            examples = [f"请根据 {item['id']} 的标准处理「{t}」，先检查既有内容并验证变更。" for t in item["triggers"][:3]]
        reference_files = sorted((source.parent / "references").glob("*.md"))
        refs = [{"name": p.stem.replace("-", " ").title(), "path": p.relative_to(EXTERNAL_DATA or ROOT).as_posix(),
                 "content": p.read_text(encoding="utf-8")} for p in reference_files]
        if EXTERNAL_DATA and item['id'] == 'work.work-hub':
            # A local guide override is private instance data, never part of
            # the Common GitLab Skill package.
            override = EXTERNAL_DATA / 'agents/private/policies/work-hub-update-policy.md'
            if override.is_file() and not override.is_symlink():
                for ref in refs:
                    if ref['path'].endswith('references/update-policy.md'):
                        ref['content'] = override.read_text(encoding='utf-8')
                        ref['path'] = 'agents/private/policies/work-hub-update-policy.md'
        skills.append({**item, "instructions": body, "examples": examples, "references": refs})
    return {"schemaVersion": 1, "source": "local-only-skills", "skills": skills}


def public_serialized():
    return json.dumps(dashboard_catalog(), ensure_ascii=False, indent=2) + "\n"


def match(query, path=None):
    active = [x for x in registry()["skills"] if x["status"] == "active"]
    explicit = [x for x in active if query.strip().casefold() in (x["id"].casefold(),x["name"].casefold(),*(a.casefold() for a in x["aliases"]))]
    if explicit:
        return {"resolution": "selected" if len(explicit)==1 else "ambiguous", "tier": "explicit", "candidates": explicit}
    if path:
        matches = [x for x in active if any(fnmatch.fnmatch(path.replace("\\", "/"), pattern) for pattern in x["scope"])]
        if matches:
            return {"resolution": "selected" if len(matches)==1 else "ambiguous", "tier": "path", "candidates": matches}
    named = [x for x in active if any(label.casefold() in query.casefold() for label in [x["name"], *x["aliases"], *x["triggers"]] if len(label)>=3)]
    return {"resolution": "selected" if len(named)==1 else ("ambiguous" if named else "ask_user"), "tier": "intent", "candidates": named}


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("build", "check", "match"))
    parser.add_argument("query", nargs="?")
    parser.add_argument("--path")
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            output = serialized()
            INDEX.parent.mkdir(parents=True, exist_ok=True)
            PUBLIC_CATALOG.parent.mkdir(parents=True, exist_ok=True)
            INDEX.write_text(output, encoding="utf-8")
            PUBLIC_CATALOG.write_text(public_serialized(), encoding="utf-8")
            if EXTERNAL_DATA:
                INDEX.chmod(0o600)
                PUBLIC_CATALOG.chmod(0o600)
            print(f"Built local Skills registry/catalog with {len(registry()['skills'])} skill(s)")
        elif args.command == "check":
            if (not INDEX.exists() or INDEX.read_text(encoding="utf-8") != serialized()
                    or not PUBLIC_CATALOG.exists() or PUBLIC_CATALOG.read_text(encoding="utf-8") != public_serialized()):
                print("Skills registry/dashboard is missing or stale: run python3 tools/project_skills.py build", file=sys.stderr)
                return 1
            print(f"PASS project skills registry ({len(registry()['skills'])} skills)")
        else:
            if not args.query and not args.path:
                parser.error("match requires query or --path")
            print(json.dumps(match(args.query or "", args.path), ensure_ascii=False, indent=2))
    except (ValueError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
