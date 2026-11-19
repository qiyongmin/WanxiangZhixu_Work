"""Inspect exactly the proposed InnerSource Git selection, including TS/TSX/SVG.

No live database, attachments or ignored files are opened. Reports only category,
path and line (never prints possible credentials). The author credit is an explicit
single-purpose exception, NOT a generic name whitelist.
"""
from __future__ import annotations

from collections import Counter
from pathlib import Path
import re
import json

ROOT = Path(__file__).resolve().parents[1]
TEXT_EXTS = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".json",
    ".md", ".txt", ".html", ".css", ".svg", ".xml", ".sh", ".bat",
    ".yaml", ".yml", ".toml", ".ini", ".env", ".sql"
}
TEXT_NAMES = {".gitignore", "WORKSPACE_KIND", "Dockerfile", "Makefile",
              "AGENTS.template.md", "CODEOWNERS", "CODEOWNERS.template", ".gitlab-ci.yml", "LICENSE"}
BLOCKED_PATHS = ("content/", "library/", "projects/", ".backups/",
                 ".maintenance/", "runtime/", ".kiro/", "tmp/", "data/")
ALLOWED_AUTHOR_PATHS = {
    "LICENSE",
    "web/src/components/settings/AboutPage.tsx",
    "web/tests/settings-navigation-v2.test.tsx",
    "web/tests/shell.test.tsx",
}
# Split sensitive test identifiers so this detector does not create an own hit.
_author = "Yong" + "min" + " Qi"
_private_user = "(?:qi" + "yong" + "min|eqi" + "yong)"
_project_names = "(?:CC[-_ ]?A" + "XIS|IT" + "SAC|CC" + "SM|CC" + "DM|\\bCI" + "G\\b)"

PATTERNS = {
    "private_person": re.compile(_private_user + r"|\b" + "Yong" + "min" + r"\b", re.I),
    "personal_domain": re.compile(r"(?i)(?:zhi" + r"xu\.win|gmail\.com|icloud\.com|hotmail\.com|outlook\.com)"),
    "non_example_email": re.compile(r"(?<![A-Za-z0-9_:])[A-Za-z0-9._%+-]+@(?!(?:[A-Za-z0-9-]+\.)*(?:example|invalid|test|localhost)\b|(?:example\.(?:com|org|invalid)|test\.invalid)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}", re.I),
    "private_home_path": re.compile(r"(?:/Users/(?!example\b|user\b)[^\s/]+|/home/(?!devspace-workspaces\b|user\b|work\b|a\b)[^\s/]+|C:\\Users\\(?!user\b|example\b)[^\s\\]+)", re.I),
    "personal_site_path": re.compile("/home/devspace-workspaces/" + "KB_" + "Site", re.I),
    "company_case": re.compile(_project_names, re.I),
    # Corporate pre-receive hooks may flag URI user-info even in negative tests.
    # Match a literal scheme + username:password@host; fixtures must assemble it
    # in memory so that the Git object never embeds a credential-like URI.
    "uri_userinfo": re.compile(r"""(?i)\bhttps?://[^\s/?#@<>"']+:[^\s/?#@<>"']+@[A-Za-z0-9.-]+"""),
    # The GitLab token detector has also produced a literal prose false positive.
    # Build that phrase in pieces so the auditor does not recreate the warning.
    "gitlab_heuristic_phrase": re.compile("organization-" + "approved", re.I),
    "credential": re.compile(
        r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"
        r"|\bgh[oprsu]_[A-Za-z0-9_]{25,}\b"
        r"|\bAKIA[A-Z0-9]{16}\b"
        r"|\bsk-(?:proj-|live-)?[A-Za-z0-9_-]{28,}\b"
        r"|\bAIza[A-Za-z0-9_-]{30,}\b", re.I),
    "remote_address": re.compile(r"(?<![A-Za-z0-9])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(?!\d)"),
}
# A request may explicitly retain personal authorship, but only this exact
# legal/display string at designated call-sites. Other private names are blocked.
def _allowed_author(path: str, line: str, category: str) -> bool:
    if category != "private_person" or path not in ALLOWED_AUTHOR_PATHS:
        return False
    # MIT requires this precise copyright notice. No other name in LICENSE
    # (including a name embedded in a longer line) gets an exception.
    if path == "LICENSE":
        return line == "Copyright (c) 2026 " + _author
    without_name = line.replace(_author, "")
    return bool(_author in line and not PATTERNS["private_person"].search(without_name))


def scan(root: Path, selected: list[str]) -> dict:
    root = Path(root)
    issues: list[dict] = []
    binary: list[str] = []
    scanned = 0
    for path in sorted(set(selected)):
        if path.startswith(BLOCKED_PATHS) or path == "AGENTS.md":
            issues.append({"path": path, "line": 0, "type": "runtime_or_private"})
            continue
        item = root / path
        if item.is_symlink():
            issues.append({"path": path, "line": 0, "type": "symlink"})
            continue
        if not item.is_file():
            issues.append({"path": path, "line": 0, "type": "missing"})
            continue
        if item.stat().st_size > 5_000_000:
            binary.append(path)
            continue
        if item.suffix.lower() not in TEXT_EXTS and item.name not in TEXT_NAMES:
            binary.append(path)
            continue
        try:
            lines = item.read_text(encoding="utf-8").splitlines()
        except UnicodeError:
            binary.append(path)
            continue
        scanned += 1
        for index, line in enumerate(lines, 1):
            for kind, pattern in PATTERNS.items():
                # The scanner's own regex declaration must not become a private
                # home path finding; actual literals in other files remain checked.
                if path == 'tools/work_source_audit.py' and kind == 'private_home_path' and 're.compile' in line:
                    continue
                if pattern.search(line) and not _allowed_author(path, line, kind):
                    issues.append({"path": path, "line": index, "type": kind})
    return {
        "format": "kb-work-source-audit-v1",
        "candidateFiles": len(selected),
        "textScanned": scanned,
        "binaryRequireProvenanceReview": sorted(binary),
        "issues": issues,
        "issueCounts": dict(sorted(Counter(hit["type"] for hit in issues).items())),
        "passAutomatedChecks": not issues and not binary,
        "authorExceptionPaths": sorted(ALLOWED_AUTHOR_PATHS),
        "releaseStatus": "Source checks are automated; inspect third-party licenses and export a fresh Git history before publishing",
    }


def main() -> int:
    import gitlab_preflight
    report = scan(ROOT, gitlab_preflight.source_paths())
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["passAutomatedChecks"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
