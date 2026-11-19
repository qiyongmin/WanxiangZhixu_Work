"""Public source-only GitHub release guardrails; never publish or mutate Work data."""
from __future__ import annotations

from pathlib import Path
import sys
import tempfile
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import work_github_public as public  # noqa: E402
import work_github_export as exporter  # noqa: E402


class PublicSourceSafety(unittest.TestCase):
    def test_candidate_only_contains_approved_source_classes(self):
        report = public.audit()
        self.assertEqual(report["privateFilesInCandidate"], [])
        self.assertEqual(report["missingRequiredPublicFiles"], [])
        self.assertEqual(report["sourceScanIssues"], [])
        self.assertTrue(report["sourceCandidateAutomatedChecksPass"], report)
        self.assertFalse(report["safeToPublishToPublicGitHub"])
        self.assertFalse(report["publicWebsiteDeploymentAllowed"])
        self.assertTrue(report["modeAStandaloneRemainsMandatory"])

    def test_old_history_is_never_assumed_safe_due_to_ignore_rules(self):
        report = public.audit()
        self.assertFalse(report["currentHistorySuitableForPublicMirror"])
        self.assertFalse(report["existingGitHistory"]["safeToReuseHistory"])

    def test_review_export_copies_only_allowlisted_source_with_no_git(self):
        with tempfile.TemporaryDirectory(prefix='kbw-public-review-parent-') as temp:
            dest = Path(temp) / 'source-review'
            manifest = exporter.export_review_copy(dest)
            self.assertGreater(manifest['fileCount'], 200)
            self.assertFalse(manifest['authorizedForPublicRelease'])
            self.assertFalse((dest / '.git').exists())
            self.assertFalse((dest / '.agents').exists())
            self.assertFalse((dest / 'content').exists())
            self.assertFalse((dest / '.gitlab-ci.yml').exists())
            self.assertTrue((dest / '.github/workflows/ci.yml').is_file())
            self.assertTrue((dest / 'tools/work_server.py').is_file())
            with self.assertRaises(FileExistsError):
                exporter.export_review_copy(dest)

    def test_history_detects_sensitive_files_even_after_deletion(self):
        with tempfile.TemporaryDirectory(prefix="kbw-public-history-test-") as temp:
            root = Path(temp)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            secret = root / ".agents/skills/local/SKILL.md"
            secret.parent.mkdir(parents=True)
            secret.write_text("Synthetic private test material", encoding="utf-8")
            subprocess.run(["git", "-C", str(root), "add", "."], check=True)
            subprocess.run(["git", "-C", str(root), "-c", "user.name=Test",
                            "-c", "user.email=test@example.invalid",
                            "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], check=True)
            secret.unlink()
            history = public.inspect_history(root)
            self.assertEqual(history["commitCount"], 1)
            self.assertIn(".agents/skills/local/SKILL.md",
                          history["privatePathsEverCommitted"])
            self.assertFalse(history["safeToReuseHistory"])


if __name__ == "__main__":
    unittest.main()
