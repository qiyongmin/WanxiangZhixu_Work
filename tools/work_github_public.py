"""Read-only public GitHub SOURCE preflight, not authorization to publish.

The public candidate is computed from the strict .gitignore allowlist via a
temporary Git index. Historic commits are checked separately: removing paths
from the current index does NOT remove their old blobs. No worktree, database,
Git refs, remotes or index are mutated; private contents are never printed.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

import gitlab_preflight
import work_source_audit

ROOT = Path(__file__).resolve().parents[1]
PRIVATE_PREFIXES = (
    ".agents/", ".backups/", ".maintenance/", ".kiro/", "content/",
    "data/", "library/", "projects/", "runtime/", "tmp/",
)
PRIVATE_NAMES = {"AGENTS.md", ".gitlab-ci.yml"}
REQUIRED_PUBLIC = {
    ".github/workflows/ci.yml", ".gitignore", "README.md",
    "PUBLIC_RELEASE.md", "SECURITY.md", "CONTRIBUTING.md",
    "THIRD_PARTY_NOTICES.md", "UI_DESIGN_SYSTEM.md",
    "ARCHITECTURE.md", "DATA_MODEL.md", "DEVELOPMENT.md",
    "OPERATIONS.md", "AGENTS.template.md", "WORKSPACE_KIND",
    "tools/work_server.py", "tools/work_init.py", "tools/work_github_public.py",
    "tools/work_github_export.py",
    "web/src/main.tsx", "web/src/styles/kbw-primitives.css",
    "web/src/styles/tokens.css", "web/package-lock.json",
    "web/tests/design-system.test.tsx", "tests/test_work_ui_design_system.py",
    "tests/test_work_github_public.py",
}


def _run(root: Path, *args: str) -> list[str]:
    result = subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise RuntimeError("Git history inspection failed")
    return result.stdout.splitlines()


def inspect_history(root: Path) -> dict:
    """Inspect path names, not contents; even a clean path audit is not a full secret scan."""
    if not (root / ".git").exists():
        return {"checked": False, "commitCount": 0, "privatePathsEverCommitted": [],
                "safeToReuseHistory": False, "reason": "No existing history assessed"}
    commits = _run(root, "rev-list", "--all")
    found: set[str] = set()
    for commit in commits:
        for path in _run(root, "ls-tree", "-r", "--name-only", commit):
            if path in PRIVATE_NAMES or path.startswith(PRIVATE_PREFIXES):
                found.add(path)
    return {
        "checked": True,
        "commitCount": len(commits),
        "privatePathsEverCommitted": sorted(found),
        "safeToReuseHistory": False,
        "reason": ("Historical private paths exist; use a NEW initial commit from the "
                   "reviewed source-only snapshot, never mirror/fork old refs"
                   if found else
                   "Path-only history inspection cannot prove old commits secret-free; "
                   "use a NEW initial commit from the reviewed source-only snapshot"),
    }


def audit(root: Path = ROOT) -> dict:
    root = Path(root)
    if root.resolve() != ROOT.resolve():
        # The source selection helper is anchored to this application's root.
        raise ValueError("Source selection must run against KB_Work root")
    selected = gitlab_preflight.source_paths()
    scan = work_source_audit.scan(root, selected)
    private = sorted(p for p in selected if p in PRIVATE_NAMES or
                     p.startswith(PRIVATE_PREFIXES) or p.startswith(".git/"))
    missing = sorted(REQUIRED_PUBLIC - set(selected))
    history = inspect_history(root)
    automated_candidate = not private and not missing and scan["passAutomatedChecks"]
    return {
        "format": "kb-work-github-public-source-v1",
        "candidateFileCount": len(selected),
        "sourceCandidateAutomatedChecksPass": automated_candidate,
        "privateFilesInCandidate": private,
        "missingRequiredPublicFiles": missing,
        "sourceScanIssues": scan["issues"],
        "binaryRequireProvenanceReview": scan["binaryRequireProvenanceReview"],
        "existingGitHistory": history,
        "currentHistorySuitableForPublicMirror": False,
        "safeToPublishToPublicGitHub": False,
        "publicWebsiteDeploymentAllowed": False,
        "modeAStandaloneRemainsMandatory": True,
        "modeBCentralPortalRemainsOptionalAndDisabled": True,
        "remainingReleaseSteps": [
            "Export and inspect ONLY the source allowlist; do not reuse legacy Git history",
            "Review bundled third-party dependency licenses and real source examples",
            "Review Git author email, final staged files, GitHub security settings and CI",
        ],
        "next": ("Export the audited source-only review copy to a NEW directory. "
                 "Create a separate initial Git commit with no legacy refs or local data; "
                 "never mirror the old GitLab history."),
    }


if __name__ == "__main__":
    report = audit()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["sourceCandidateAutomatedChecksPass"] else 2)
