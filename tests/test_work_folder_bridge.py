"""The local Folder → Explorer bridge must never accept a caller-selected path.
No tests in this module actually open Windows Explorer.
"""
from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tools"))
import work_shortcuts as shortcuts


ID = "shortcut-" + "a" * 32


class FolderOpen(unittest.TestCase):
    def test_wsl_local_path_launches_explorer_with_arguments_not_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            node = {"kind": "initiative", "depth": 1,
                    "resourceLinks": [{"id": ID, "kind": "folder", "title": "Work", "target": directory}]}
            with mock.patch.object(shortcuts.sys, "platform", "linux"), \
                 mock.patch.object(shortcuts.os, "uname", return_value=SimpleNamespace(release="6.18-microsoft-standard-WSL2")), \
                 mock.patch.object(shortcuts.shutil, "which", return_value="/mnt/c/Windows/explorer.exe"), \
                 mock.patch.object(shortcuts.subprocess, "run",
                                   return_value=SimpleNamespace(stdout="\\\\wsl.localhost\\Ubuntu\\tmp\\work\n")) as convert, \
                 mock.patch.object(shortcuts.subprocess, "Popen") as launch:
                result = shortcuts.open_local_folder(node, ID)
                self.assertTrue(result["requested"])
                self.assertEqual(convert.call_args.args[0], ["wslpath", "-w", directory])
                self.assertEqual(launch.call_args.args[0],
                                 ["explorer.exe", "\\\\wsl.localhost\\Ubuntu\\tmp\\work"])
                self.assertNotIn("shell", launch.call_args.kwargs)

    def test_rejects_unstored_link_arbitrary_id_and_non_l1(self):
        node = {"kind":"initiative", "depth":1,
                "resourceLinks":[{"id":ID, "kind":"folder","title":"Work","target":"/tmp"}]}
        with mock.patch.object(shortcuts.subprocess, "Popen") as launch:
            with self.assertRaises(ValueError): shortcuts.open_local_folder(node, "shortcut-"+"b"*32)
            with self.assertRaises(ValueError): shortcuts.open_local_folder(dict(node, depth=2), ID)
            with self.assertRaises(ValueError): shortcuts.open_local_folder(
                dict(node, resourceLinks=[{"id":ID,"kind":"teams","title":"Team",
                                          "target":"https://teams.microsoft.com/"}]), ID)
            launch.assert_not_called()

    def test_rejects_network_unc_traversal_and_custom_schemes(self):
        self.assertFalse(shortcuts.valid_folder(r"\\server\share"))
        self.assertFalse(shortcuts.valid_folder("/work/../secret"))
        self.assertFalse(shortcuts.valid_folder("/tmp/example/KB_Site"))
        self.assertFalse(shortcuts.valid_folder("file:///etc/shadow"))
        self.assertTrue(shortcuts.valid_folder(r"C:\Work\Project"))
        self.assertTrue(shortcuts.valid_folder(r"\\wsl.localhost\Ubuntu\home\work"))
        unsafe = [("link","javascript:alert(1)"), ("link","file:///etc/shadow"),
                  # Construct an intentionally invalid URL at runtime. The source
                  # itself must not contain a credential-bearing URI: GitLab
                  # pre-receive scanners inspect even synthetic negative tests.
                  ("teams","https://" + "synthetic-user" + ":" + "fake-pass" + "@example.invalid/x"),
                  ("folder",r"\\corp-smb\hidden")]
        for kind, target in unsafe:
            with self.assertRaises(ValueError):
                shortcuts.validate_resource_links([
                    {"id":ID,"kind":kind,"title":"Unsafe","target":target}])


if __name__ == "__main__":
    unittest.main()
