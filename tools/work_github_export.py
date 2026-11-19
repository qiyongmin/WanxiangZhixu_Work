"""Make a NEW, local, source-only review copy for a future GitHub root commit.

No git init, remotes, network access, publish or live-data migration.
This intentionally exports the CURRENT allowlisted files, not existing commits.
The destination must not exist and must be outside KB_Work.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from shutil import copy2

import gitlab_preflight
import work_github_public

ROOT = Path(__file__).resolve().parents[1]


def digest(file: Path) -> str:
    hasher = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
    return hasher.hexdigest()


def export_review_copy(destination: Path) -> dict:
    review = work_github_public.audit()
    if not review["sourceCandidateAutomatedChecksPass"]:
        issues = review.get("sourceScanIssues") or []
        details = ", ".join("{}:{} [{}]".format(entry["path"], entry["line"], entry["type"]) for entry in issues[:5])
        missing = review.get("missingRequiredPublicFiles") or []
        raise ValueError("Public source candidate failed automated checks. "
                         + (f"Findings: {details}. " if details else "")
                         + (f"Missing: {', '.join(missing)}. " if missing else "")
                         + "Fix the reported findings, rerun tools/work_source_audit.py and retry.")
    base = ROOT.resolve()
    target = Path(destination).expanduser().resolve()
    if target == base or target.is_relative_to(base) or base.is_relative_to(target):
        raise ValueError("Review copy must be outside KB_Work and its ancestors")
    if target.exists():
        raise FileExistsError("Target exists: choose a NEW empty destination")
    if not target.parent.is_dir():
        raise ValueError("Target parent directory must already exist")
    files = sorted(gitlab_preflight.source_paths())
    # Validate the full manifest BEFORE creating any output directory.
    for relative in files:
        source = base / relative
        if source.is_symlink() or not source.is_file() or not source.resolve().is_relative_to(base):
            raise ValueError("Unsafe source file in reviewed selection")
    target.mkdir()
    for relative in files:
        original = base / relative
        copied = target / relative
        copied.parent.mkdir(parents=True, exist_ok=True)
        copy2(original, copied)
        if digest(original) != digest(copied):
            raise RuntimeError("Review-copy hash mismatch; do not publish")
    return {"format": "kb-work-source-review-copy-v1",
            "fileCount": len(files), "reviewCopy": str(target),
            "gitHistoryCopied": False, "localUserDataCopied": False,
            "authorizedForPublicRelease": False}


def main() -> int:
    parser = argparse.ArgumentParser(description="Local GitHub source-only REVIEW copy")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--review-copy", action="store_true",
                        help="Explicitly copy only audited source; does not publish")
    args = parser.parse_args()
    if not args.review_copy:
        parser.error("--review-copy is required; this does not authorize GitHub publication")
    print(json.dumps(export_review_copy(args.output), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
