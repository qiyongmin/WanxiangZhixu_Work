"""Portable colleague onboarding documentation consistency.

No network, runtime data or source tree modifications.
"""
from __future__ import annotations

from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import gitlab_preflight  # noqa: E402

DOCS = ("README.md", "DEPLOYMENT_WINDOWS_WSL_ZH.md", "ARCHITECTURE.md",
        "OPERATIONS.md", "SECURITY.md", "AGENTS.template.md", "PUBLIC_RELEASE.md",
        "CONTRIBUTING.md", "UI_DESIGN_SYSTEM.md", "THIRD_PARTY_NOTICES.md")


class ColleagueDocsTests(unittest.TestCase):
    def test_local_markdown_links_exist(self):
        selected = set(gitlab_preflight.source_paths())
        for path in DOCS:
            self.assertIn(path, selected, "Required colleague documentation must be in the slim source")
            file = ROOT / path
            self.assertTrue(file.is_file(), path)
            body = file.read_text(encoding="utf-8")
            for url in re.findall(r"\]\(([^)]+\.md)(?:#[^)]*)?\)", body):
                if url.startswith(("http://", "https://")):
                    continue
                resolved = (file.parent / url).resolve()
                with self.subTest(path=path, link=url):
                    self.assertTrue(resolved.is_relative_to(ROOT.resolve()))
                    self.assertTrue(resolved.is_file(), f"{path}: {url}")
                    self.assertIn(resolved.relative_to(ROOT).as_posix(), selected,
                                  f"Broken link in a clean clone: {path} -> {url}")

    def test_readme_explains_first_time_setup_and_office_capabilities(self):
        body = (ROOT / "README.md").read_text(encoding="utf-8")
        for required in ("wsl --install", "libreoffice", "openpyxl", "python3 -m venv",
                         "npm --prefix web run build", "tools/work_init.py",
                         "tools/work_doctor.py", "localhost:8001/app/",
                         "start.sh", "stop.sh", "start.bat",
                         "GitHub", "single-user", "WSL2"):
            with self.subTest(required=required):
                self.assertIn(required, body)
        self.assertIn("not fully validated", body)

    def test_docs_do_not_tell_colleagues_to_copy_existing_databases(self):
        for file in DOCS:
            content = (ROOT / file).read_text(encoding="utf-8").lower()
            self.assertNotIn("copy another employee's work.sqlite3", content)

    def test_chinese_guide_has_real_commands(self):
        text = (ROOT / "DEPLOYMENT_WINDOWS_WSL_ZH.md").read_text(encoding="utf-8")
        for name in ("wsl --list --verbose", "sudo apt install",
                     "python -m pip install -r requirements.txt",
                     "npm --prefix web ci", "python tools/work_doctor.py",
                     "Office", "Windows", "WSL2"):
            with self.subTest(name=name):
                self.assertIn(name, text)


if __name__ == "__main__":
    unittest.main()
