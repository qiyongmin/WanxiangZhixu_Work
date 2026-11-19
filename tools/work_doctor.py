"""Read-only KB_Work colleague deployment preflight.

Usage: python3 tools/work_doctor.py
Never modifies files, executes installers, touches work records or reads secrets.
"""
from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def _version(name):
    binary = shutil.which(name)
    if not binary:
        return None
    try:
        value = subprocess.run([binary, "--version"], capture_output=True,
                               text=True, timeout=5, check=True)
    except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired):
        return None
    return (value.stdout or value.stderr).strip().splitlines()[0][:100]


def _node_supported(version):
    if not version:
        return False
    match = re.match(r"^v?(\d+)\.(\d+)", version)
    if not match:
        return False
    major, minor = (int(part) for part in match.groups())
    # Tested release: Node 22; supported Vite 8 runtime: Node >=20.19 / >=22.12.
    return (major == 20 and minor >= 19) or (major == 22 and minor >= 12) or major >= 24


def _python_module(name):
    return importlib.util.find_spec(name) is not None


def _cryptography_requirement():
    try:
        version = importlib.metadata.version("cryptography")
    except importlib.metadata.PackageNotFoundError:
        return {"version": None, "matchesRequirements": False}
    match = re.match(r"^(\d+)", version)
    major = int(match.group(1)) if match else -1
    return {"version": version, "matchesRequirements": 42 <= major < 48}


def inspect(root=ROOT):
    root = Path(root).resolve()
    system = platform.system()
    release = platform.release()
    is_wsl = system == "Linux" and "microsoft" in release.lower()
    is_win = system == "Windows"
    marker = root / "WORKSPACE_KIND"
    valid = marker.is_file() and marker.read_text(encoding="utf-8").strip() == "KB_WORK_STANDALONE_V1"
    node = _version("node")
    npm = _version("npm")
    converter = shutil.which("libreoffice") or shutil.which("soffice")
    work_db = root / "content/work-hub/work.sqlite3"
    hub_db = root / "content/file-hub/catalog.sqlite3"
    built = (root / "app/index.html").is_file()
    python_ok = sys.version_info >= (3, 12)
    deps_ok = _python_module("cryptography")
    cryptography = _cryptography_requirement()
    platform_ok = not is_win
    warnings = []
    if is_win:
        warnings.append("Windows-native mode is not end-to-end validated; stop_server and local Explorer bridges are WSL/Linux-specific. Use WSL2.")
    if is_wsl and str(root).startswith("/mnt/"):
        warnings.append("For WSL SQLite reliability and performance, clone under the Linux home directory (~), not /mnt/c or a network share.")
    if not converter:
        warnings.append("LibreOffice not found on executable PATH: Office-to-PDF high-fidelity preview is unavailable; basic Work features remain usable.")
    if not _python_module("openpyxl"):
        warnings.append("openpyxl not installed: XLSX Sheet Browser is unavailable, while other Work features remain usable.")
    if not work_db.is_file():
        warnings.append("Work SQLite is not initialized: run python3 tools/work_init.py in a fresh clone.")
    if not built:
        warnings.append("React app is not built: run npm --prefix web ci and npm --prefix web run build.")
    if not python_ok:
        warnings.append("Python 3.12+ recommended: older versions are not covered by current verified deployment baseline.")
    if not _node_supported(node):
        warnings.append("Node.js 22.12+ or another Vite-8-supported Node release is required; Node 22 LTS is the tested baseline.")
    if not deps_ok:
        warnings.append("Required Python cryptography module missing: install requirements.txt in the active Python environment.")
    elif not cryptography["matchesRequirements"]:
        warnings.append("Installed cryptography is outside the requirements.txt version range (>=42,<48); use a fresh project .venv and install requirements.txt. An existing local server may still run.")
    return {
        "format": "kb-work-deployment-doctor-v1",
        "workspaceValid": valid,
        "platform": {"system": system, "release": release, "wsl": is_wsl,
                     "windowsNativeValidated": False},
        "dependencies": {
            "python": platform.python_version(), "pythonBaselineOk": python_ok,
            "node": node, "nodeSupported": _node_supported(node),
            "npm": npm, "cryptography": deps_ok,
            "cryptographyVersion": cryptography["version"],
            "cryptographyMatchesRequirements": cryptography["matchesRequirements"],
            "libreOfficePathFound": bool(converter),
            "libreOfficeVersion": (_version("libreoffice") or _version("soffice")) if converter else None,
            "xlsxSheetBrowserDependency": _python_module("openpyxl")
        },
        "workspace": {"workDbInitialized": work_db.is_file(),
                      "fileHubCatalogExists": hub_db.is_file(),
                      "frontendBuilt": built},
        "canInstallAndBuild": bool(valid and python_ok and deps_ok and
                                   _node_supported(node) and npm and platform_ok),
        "readyToStart": bool(valid and python_ok and deps_ok and _node_supported(node)
                             and npm and platform_ok and work_db.is_file() and built),
        "warnings": warnings,
        "note": "Read-only checks; no live database integrity checks, credential access, network calls or file modifications."
    }


def main():
    report = inspect()
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report["readyToStart"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
