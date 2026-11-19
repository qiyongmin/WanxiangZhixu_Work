"""V1.1 Mode A stays independent; external Data Root is opt-in and isolated."""
from __future__ import annotations
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from urllib.request import urlopen
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
import work_instance_paths as paths

class DualModePaths(unittest.TestCase):
    def test_default_mode_and_paths_are_unchanged(self):
        script = (ROOT / "start.sh").read_text()
        self.assertIn('KB_WORK_MODE:-local', script)
        self.assertIn('export KB_WORK_HUB_DB="$ROOT/content/work-hub/work.sqlite3"', script)
        self.assertIn('export KB_FILE_HUB_DATA="$ROOT/content/file-hub"', script)
        self.assertIn('Portal mode is not approved/implemented', script)
        self.assertIn("ThreadingHTTPServer((\"127.0.0.1\", args.port)", (ROOT / "tools/work_server.py").read_text())

    def test_rejects_source_and_symlinks(self):
        with self.assertRaises(paths.InstanceError):
            paths.resolve(ROOT)
        with tempfile.TemporaryDirectory(prefix="work-dataroot-") as tmp:
            root = Path(tmp)
            (root / "link").symlink_to(root / "safe", target_is_directory=True)
            with self.assertRaises(paths.InstanceError):
                paths.resolve(root / "link", exists=False)
            with self.assertRaises(paths.InstanceError):
                paths.resolve("relative", exists=False)

    def test_explicit_new_instance_no_source_mutation(self):
        with tempfile.TemporaryDirectory(prefix="kbw-v11-") as tmp:
            external = Path(tmp) / "instance"
            source_db = ROOT / "content/work-hub/work.sqlite3"
            before = source_db.stat().st_mtime_ns if source_db.exists() else None
            created = paths.initialize(external)
            self.assertTrue(created["ready"])
            self.assertEqual(created["sections"],
                             ["Initiatives", "Team Management", "Knowledge", "Projects"])
            self.assertTrue((external / "library/Projects").is_dir())
            self.assertTrue((external / "agents/private/skills").is_dir())
            self.assertEqual(paths.env_paths(external)["KB_WORK_HUB_DB"],
                             str(external / "content/work-hub/work.sqlite3"))
            self.assertEqual(paths.verify(external)["databases"]
                             ["content/file-hub/catalog.sqlite3"]["integrity"], "ok")
            with self.assertRaises(paths.InstanceError):
                paths.initialize(external)
            if before is not None:
                self.assertEqual(source_db.stat().st_mtime_ns, before)

    def test_external_mode_local_http_server_reads_its_own_empty_instance(self):
        with tempfile.TemporaryDirectory(prefix="kbw-v11-http-") as tmp:
            external = Path(tmp) / "instance"
            paths.initialize(external)
            env = {**os.environ, "KB_WORK_DATA_ROOT": str(external), "KB_WORK_MODE": "local"}
            with socket.socket() as sock:
                sock.bind(("127.0.0.1", 0))
                port = sock.getsockname()[1]
            server = subprocess.Popen(
                ["bash", "start.sh", str(port), "--foreground", "--no-restart", "--no-browser"],
                cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            try:
                for _ in range(80):
                    if server.poll() is not None:
                        self.fail("External instance startup failed: " + server.stderr.read().decode(errors="replace")[-1800:])
                    try:
                        with urlopen(f"http://127.0.0.1:{port}/local/v1/capabilities",timeout=2) as reply:
                            caps = json.load(reply)
                        break
                    except Exception:
                        time.sleep(0.1)
                else:
                    self.fail("External instance server not ready")
                self.assertEqual(caps["data"]["protocolMax"], 1)
                self.assertFalse(caps["data"]["portalPairingEnabled"])
                with urlopen(f"http://127.0.0.1:{port}/api/work-hub?view=tree", timeout=3) as reply:
                    tree = json.load(reply)["data"]
                with urlopen(f"http://127.0.0.1:{port}/data/project-skills.json",timeout=3) as reply:
                    catalog = json.load(reply)
                self.assertEqual({x['id'] for x in catalog['skills']},
                                 set())
                with urlopen(f"http://127.0.0.1:{port}/data/index.json",timeout=3) as reply:
                    index = json.load(reply)
                self.assertEqual(index['deploymentProfile'], 'work')
                self.assertEqual(tree["nodes"], [])
                self.assertEqual(len(tree["sections"]), 4)
                with urlopen(f"http://127.0.0.1:{port}/app/", timeout=4) as reply:
                    self.assertEqual(reply.status, 200)
            finally:
                server.terminate()
                try:
                    server.communicate(timeout=6)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.communicate()

    def test_site_boundary_expected_external_paths(self):
        with tempfile.TemporaryDirectory(prefix="kbw-v11-") as tmp:
            external = Path(tmp) / "instance"
            paths.initialize(external)
            env = {"KB_WORK_DATA_ROOT": str(external), "KB_SITE_PROFILE": "work",
                   **paths.env_paths(external)}
            command = [sys.executable, "-c",
                       "import site_boundary; site_boundary.validate_isolated_runtime(); print('PASS')"]
            with patch.dict(os.environ, env):
                p = subprocess.run(command, cwd=ROOT / "tools", capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stderr)
            with patch.dict(os.environ, dict(env, KB_FILE_HUB_LIBRARY=str(ROOT / "library"))):
                p = subprocess.run(command, cwd=ROOT / "tools", capture_output=True, text=True)
            self.assertNotEqual(p.returncode, 0)

if __name__ == "__main__":
    unittest.main()
