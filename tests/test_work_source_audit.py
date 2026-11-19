"""InnerSource source scanner regression: synthetic values only."""
from pathlib import Path
import tempfile
import unittest

from tools import work_source_audit as audit


class SourceAuditTests(unittest.TestCase):
    def test_explicit_author_credit_only(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            relative = "web/src/components/settings/AboutPage.tsx"
            source = root / relative
            source.parent.mkdir(parents=True)
            author = "Yong" + "min Qi"
            source.write_text('Author: '+author, encoding="utf-8")
            self.assertEqual(audit.scan(root, [relative])["issues"], [])
            other = "web/src/lib/secret.ts"
            path = root / other
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('Author: '+author, encoding="utf-8")
            result = audit.scan(root, [other])
            self.assertEqual(result["issueCounts"]["private_person"], 1)

    def test_mit_license_exact_copyright_notice_only(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            license_file = root / "LICENSE"
            author = "Yong" + "min Qi"
            license_file.write_text("MIT License\n\nCopyright (c) 2026 " + author + "\n", encoding="utf-8")
            self.assertEqual(audit.scan(root, ["LICENSE"])["issues"], [])
            for bad in ("Extra: " + author, "Copyright (c) 2026 " + author + " / private",
                        "Copyright (c) 2025 " + author, "Copyright (c) 2026 " + author + " extra"):
                license_file.write_text(bad + "\n", encoding="utf-8")
                self.assertEqual(audit.scan(root, ["LICENSE"])["issueCounts"]["private_person"], 1)

    def test_token_and_project_cases_are_blocked_in_tsx_svg_and_tests(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, content in {
                "web/src/Comp.tsx": 'const a = "CC" + "-AXIS";\nconst x="IT"+"SAC";',
                "web/public/demo.svg": '<svg><text>CC'+'-AXIS</text></svg>',
                "tests/fixture.py": 'secret = "' + "ghp_" + "A" * 30 + '"',
            }.items():
                item = root / name
                item.parent.mkdir(parents=True, exist_ok=True)
                item.write_text(content, encoding="utf-8")
            report = audit.scan(root, ["web/public/demo.svg", "tests/fixture.py"])
            self.assertFalse(report["passAutomatedChecks"])
            self.assertEqual(report["issueCounts"]["company_case"], 1)
            self.assertEqual(report["issueCounts"]["credential"], 1)

    def test_gitlab_pre_receive_uri_and_prose_false_positives_are_blocked(self):
        # Build synthetic strings at runtime, never embed scanned values in Git.
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            file = root / "tests/unsafe_fixtures.py"
            file.parent.mkdir(parents=True)
            credential_url = "https://" + "synthetic-user" + ":" + "fake-pass" + "@example.invalid/"
            misleading_prose = "organization-" + "approved"
            file.write_text(credential_url + "\n" + misleading_prose, encoding="utf-8")
            result = audit.scan(root, ["tests/unsafe_fixtures.py"])
            self.assertEqual(result["issueCounts"]["uri_userinfo"], 1)
            self.assertEqual(result["issueCounts"]["gitlab_heuristic_phrase"], 1)
            self.assertFalse(result["passAutomatedChecks"])

    def test_private_and_symlink_files_never_enter_repository(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            item = root / "content/work-hub/work.sqlite3"
            item.parent.mkdir(parents=True)
            item.write_bytes(b"sqlite")
            report = audit.scan(root, ["content/work-hub/work.sqlite3"])
            self.assertEqual(report["issueCounts"]["runtime_or_private"], 1)

    def test_actual_source_candidate_has_no_disallowed_private_or_company_terms(self):
        import sys
        sys.path.insert(0, str(audit.ROOT / "tools"))
        import gitlab_preflight
        report = audit.scan(audit.ROOT, gitlab_preflight.source_paths())
        self.assertEqual(report["issues"], [], "Source candidate must be clean before GitLab")
        self.assertEqual(report["binaryRequireProvenanceReview"], [])


if __name__ == "__main__":
    unittest.main()
