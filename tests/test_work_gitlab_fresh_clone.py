"""GitLab preflight: a source-only clone initializes and runs with zero user data.

Creates its own temporary Git index and temporary checkout; never creates a
.git in KB_Work, never reads a personal site or mutates the live Work database.
"""
from __future__ import annotations

import json
import os
import pathlib
import socket
import subprocess
import tempfile
import time
import unittest
from urllib.request import urlopen

ROOT = pathlib.Path(__file__).resolve().parents[1]
FORBIDDEN_PREFIX = (
    "content/", "library/", "projects/", ".backups/", ".maintenance/", "data/",
    "docs/PRIVATE_", ".kiro/", "tmp/",
)
FORBIDDEN_NAMES = {
    "AGENTS.md", "BUILD_VERIFICATION.json", "tools/work_hub_seed.py",
    "web/public/initiative-level1-v1.html", "app/initiative-level1-v1.html",
}


def run(args, cwd, **kw):
    p = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       text=True, check=False, **kw)
    if p.returncode:
        raise AssertionError(f"{args!r}: exit {p.returncode}: {p.stderr[-2500:]}")
    return p.stdout


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class CleanWorkGitClone(unittest.TestCase):
    def test_source_only_clone_bootstraps_with_zero_private_data(self):
        with tempfile.TemporaryDirectory(prefix="kb-work-clean-gitlab-") as temp:
            folder = pathlib.Path(temp)
            clone = folder / "clone"
            run(["git", "init", "-q", "-b", "main"], folder)
            run(["git", "--git-dir", str(folder / ".git"), "--work-tree", str(ROOT),
                 "add", "-A"], folder)
            selected = set(run(["git", "ls-files"], folder).splitlines())
            self.assertFalse([p for p in selected if p.startswith(FORBIDDEN_PREFIX)])
            self.assertFalse(sorted(selected & FORBIDDEN_NAMES))
            for necessary in (
                "WORKSPACE_KIND", "README.md", "AGENTS.template.md",
                "tools/work_server.py", "tools/work_init.py",
                "tools/work_hub_store.py", "tools/work_hub_sections.py",
                "tools/work_hub_schema.py", "tools/project_skills.py",
                "web/index.html", "web/public/wanxiang-work.svg",
                "web/src/main.tsx", "tests/work_empty_clone.browser.cjs",
            ):
                self.assertIn(necessary, selected, necessary)
            run(["git", "-c", "user.name=Local QA", "-c",
                 "user.email=local@example.invalid", "-c", "commit.gpgsign=false",
                 "commit", "-qm", "clean Work source candidate"], folder)
            run(["git", "clone", "--no-hardlinks", "-q", str(folder), str(clone)], folder)

            result = json.loads(run(["python3", "tools/work_init.py"], clone))
            self.assertEqual(result["records"], 0)
            self.assertEqual(result["sectionTitles"],
                             ["Initiatives", "Team Management", "Knowledge", "Projects"])
            self.assertTrue((clone / "AGENTS.md").exists())
            self.assertTrue((clone / "data/project-skills.json").exists())
            skills = json.loads((clone / "data/project-skills.json").read_text(encoding="utf-8"))
            self.assertEqual(skills["skills"], [])
            self.assertFalse(any(path.startswith(".agents/skills/") for path in selected))
            self.assertIn("existing", run(["python3", "tools/work_init.py"], clone))
            # Exercise the shipped CI Python suite INSIDE the minimum clone.
            # Tests hidden by the real workstation must not mask missing imports.
            smoke_modules = (
                "tests.test_work_clean_init", "tests.test_work_demo",
                "tests.test_work_source_audit", "tests.test_work_doctor",
                "tests.test_work_install_docs", "tests.test_work_office_headless_smoke",
                "tests.test_work_housekeeping", "tests.test_work_backup_private",
                "tests.test_work_v2_release_gate", "tests.test_work_v2_nodes",
                "tests.test_work_v2_materials", "tests.test_work_v2_agent",
                "tests.test_work_folder_bridge",
            )
            run(["python3", "-m", "unittest", *smoke_modules, "-q"], clone)
            run(["npm", "--prefix", "web", "ci", "--offline", "--ignore-scripts"], clone)
            self.assertFalse((clone / 'app/index.html').exists(), 'Compiled app must be generated, not checked into Git')
            run(["npm", "--prefix", "web", "run", "build"], clone)
            self.assertTrue((clone / 'app/index.html').exists())
            run(["npm", "--prefix", "web", "run", "test", "--", "--reporter=dot"], clone)
            # V1.1 permanent Mode A gate: the same source clone must run
            # without Portal identity, pairing, remote service or data copy.
            run(["python3", "-m", "unittest", "tests.test_work_dual_mode",
                 "tests.test_work_v11_skills_backup", "tests.test_work_portal_protocol", "-q"], clone)

            endpoint = f"http://127.0.0.1:{port()}"
            listen_port = endpoint.rsplit(":", 1)[-1]
            server = subprocess.Popen(["bash", "start.sh", listen_port, "--foreground", "--no-restart", "--no-browser"],
                                      cwd=clone, stdout=subprocess.DEVNULL,
                                      stderr=subprocess.PIPE)
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        self.fail("Empty Work clone server crashed: " +
                                  server.stderr.read().decode(errors="replace")[:1800])
                    try:
                        with urlopen(endpoint + "/api/work-hub?view=tree", timeout=3) as response:
                            tree = json.load(response)["data"]
                        break
                    except Exception:
                        time.sleep(.15)
                else:
                    self.fail("Empty Work clone did not come online")
                self.assertEqual(tree["nodes"], [])
                self.assertEqual([s["title"] for s in tree["sections"]],
                                 ["Initiatives", "Team Management", "Knowledge", "Projects"])
                # Old compatibility GET must never seed any other person's real project.
                with urlopen(endpoint + "/api/work-hub", timeout=5) as response:
                    legacy = json.load(response)["data"]
                self.assertEqual(legacy, [], "legacy GET must not create demo records")
                with urlopen(endpoint + "/api/work-hub?view=tree", timeout=5) as response:
                    self.assertEqual(json.load(response)["data"]["nodes"], [])
                for route in ("/app/", "/data/project-skills.json", "/data/index.json",
                              "/app/wanxiang-work.svg"):
                    self.assertEqual(urlopen(endpoint + route, timeout=5).status, 200)
            finally:
                server.terminate()
                try:
                    server.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.communicate()

            # Browser uses an optional locally supplied Playwright installation;
            # no hardcoded dependency on any personal project or machine path.
            if os.environ.get("KB_WORK_PLAYWRIGHT_PATH"):
                run(["node", "tests/work_empty_clone.browser.cjs"], clone,
                    env=os.environ.copy())
            # Demo is strictly opt-in and only tested AFTER blank-clone API checks.
            demo = json.loads(run(["python3", "tools/work_demo.py",
                                   "--confirm-synthetic-demo"], clone))
            self.assertEqual((demo['recordCount'],demo['pageCount'],demo['eventCount']), (5,1,1))
            import sqlite3
            with sqlite3.connect(clone / 'content/work-hub/work.sqlite3') as con:
                self.assertEqual(con.execute('SELECT count(*) FROM records').fetchone()[0], 5)
                self.assertEqual(con.execute('SELECT count(*) FROM work_note_pages').fetchone()[0], 1)
            print("PASS source-only empty Work Git clone:",
                  len(selected), "tracked files; zero records and four Sections; opt-in fake demo")


if __name__ == "__main__":
    unittest.main()
