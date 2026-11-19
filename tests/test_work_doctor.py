"""Read-only deployment doctor and portable prerequisite checking."""
from __future__ import annotations

import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import work_doctor


class DoctorTests(unittest.TestCase):
    def test_cryptography_install_range(self):
        with mock.patch.object(work_doctor.importlib.metadata, "version", return_value="41.0.7"):
            self.assertFalse(work_doctor._cryptography_requirement()["matchesRequirements"])
        with mock.patch.object(work_doctor.importlib.metadata, "version", return_value="42.1.0"):
            self.assertTrue(work_doctor._cryptography_requirement()["matchesRequirements"])
        with mock.patch.object(work_doctor.importlib.metadata, "version", return_value="48.0.0"):
            self.assertFalse(work_doctor._cryptography_requirement()["matchesRequirements"])

    def test_node_compatibility(self):
        for version in ("v22.23.2", "v22.12.0", "v20.19.0", "v24.0.0"):
            self.assertTrue(work_doctor._node_supported(version), version)
        for version in ("v18.20.0", "v20.18.0", "v22.11.0", "garbled", None):
            self.assertFalse(work_doctor._node_supported(version), version)

    def test_doctor_never_initializes_data_and_reports_optional_tools(self):
        with tempfile.TemporaryDirectory(prefix="kbw-doctor-test-") as temp:
            root = Path(temp)
            (root / "WORKSPACE_KIND").write_text("KB_WORK_STANDALONE_V1")
            with (mock.patch.object(work_doctor.platform, "system", return_value="Linux"),
                  mock.patch.object(work_doctor.platform, "release", return_value="5.15.0-microsoft-standard"),
                  mock.patch.object(work_doctor, "_version", side_effect=lambda binary: {
                      "node": "v22.23.2", "npm": "10.9.8"
                  }.get(binary)),
                  mock.patch.object(work_doctor, "_python_module", side_effect=lambda name: name == "cryptography"),
                  mock.patch.object(work_doctor.shutil, "which", return_value=None)):
                report = work_doctor.inspect(root)
            self.assertTrue(report["platform"]["wsl"])
            self.assertFalse(report["readyToStart"])
            self.assertEqual(report["dependencies"]["libreOfficePathFound"], False)
            self.assertFalse(report["dependencies"]["xlsxSheetBrowserDependency"])
            self.assertFalse((root / "content").exists())
            self.assertFalse((root / "app").exists())

    def test_windows_native_is_never_claimed_validated(self):
        with tempfile.TemporaryDirectory(prefix="kbw-doctor-test-") as temp:
            root = Path(temp)
            (root / "WORKSPACE_KIND").write_text("KB_WORK_STANDALONE_V1")
            (root / "content/work-hub").mkdir(parents=True)
            (root / "content/work-hub/work.sqlite3").write_bytes(b"test-only")
            (root / "app").mkdir()
            (root / "app/index.html").write_text("test")
            with (mock.patch.object(work_doctor.platform, "system", return_value="Windows"),
                  mock.patch.object(work_doctor.platform, "release", return_value="11"),
                  mock.patch.object(work_doctor, "_version", side_effect=lambda binary: {
                      "node": "v22.23.2", "npm": "10.9.8"
                  }.get(binary)),
                  mock.patch.object(work_doctor, "_python_module", return_value=True),
                  mock.patch.object(work_doctor.shutil, "which", return_value=None)):
                report = work_doctor.inspect(root)
            self.assertFalse(report["readyToStart"])
            self.assertFalse(report["platform"]["windowsNativeValidated"])
            self.assertTrue(any("Windows-native" in warning for warning in report["warnings"]))


if __name__ == "__main__":
    unittest.main()
