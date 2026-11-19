"""Work-only first-level shortcuts: tightly constrained metadata and a local WSL Explorer launcher.

A folder shortcut is NOT a file upload or a File Hub reference. This module
never reads, lists, uploads or modifies source folder contents. The native
launcher is reachable only from the Work loopback server after same-origin
validation, and resolves a stored shortcut ID rather than a caller path.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from urllib.parse import urlsplit

ALLOWED_KINDS = frozenset(("folder", "sharepoint", "eridoc", "teams", "link"))
ROOT_KINDS = frozenset(("initiative", "topic", "knowledge_collection"))
SHORTCUT_ID = re.compile(r"shortcut-[0-9a-f]{32}\Z")
WINDOWS_DRIVE = re.compile(r"^[A-Za-z]:\\[^\x00-\x1f<>:\"|?*]*\Z")
WSL_UNC = re.compile(r"^\\\\(?:wsl\.localhost|wsl\$)\\[^\\/]+\\[^\x00-\x1f<>:\"|?*]*\Z", re.I)
MAX_SHORTCUTS = 24


def valid_folder(value: str) -> bool:
    if not isinstance(value, str) or not value or len(value) > 1200:
        return False
    if value.strip() != value or any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return False
    # Dot segments and UNC hosts other than the local WSL namespace are unsafe
    # (UNC SMB hosts can trigger implicit enterprise authentication).
    parts = re.split(r"[\\/]+", value)
    if any(part in (".", "..") or part.casefold() == "kb_site" for part in parts):
        # Work-only must never open or depend on the separately owned personal KB site.
        return False
    if value.startswith("/") and not value.startswith("//"):
        return True
    return bool(WINDOWS_DRIVE.fullmatch(value) or WSL_UNC.fullmatch(value))


def validate_resource_links(entries):
    if not isinstance(entries, list) or len(entries) > MAX_SHORTCUTS:
        raise ValueError("resourceLinks must be a list of at most 24 entries")
    result, seen = [], set()
    for item in entries:
        if not isinstance(item, dict) or set(item) != {"id", "kind", "title", "target"}:
            raise ValueError("Each shortcut must have id, kind, title and target only")
        ident, kind, title, target = (item.get(k) for k in ("id", "kind", "title", "target"))
        if not isinstance(ident, str) or not SHORTCUT_ID.fullmatch(ident) or ident in seen:
            raise ValueError("Shortcut IDs must be unique stable UUIDs")
        seen.add(ident)
        if kind not in ALLOWED_KINDS:
            raise ValueError("Invalid shortcut category")
        if not isinstance(title, str) or not (1 <= len(title.strip()) <= 120) or title != title.strip() or any(ord(ch) < 32 for ch in title):
            raise ValueError("Shortcut title must be 1–120 printable characters")
        if not isinstance(target, str) or not (1 <= len(target) <= 1200):
            raise ValueError("Shortcut target must be 1–1200 characters")
        if kind == "folder":
            if not valid_folder(target):
                raise ValueError("Folder path must be an absolute local Windows or WSL path")
        else:
            if target.strip() != target or any(ord(ch) < 32 for ch in target) or any(ch in '<>\\' for ch in target):
                raise ValueError("Invalid web link")
            url = urlsplit(target)
            if url.scheme.lower() not in ("https", "http") or not url.hostname or url.username or url.password or len(url.netloc) > 255:
                raise ValueError("Links must use HTTP(S) without embedded credentials")
        result.append({"id": ident, "kind": kind, "title": title, "target": target})
    return result


def _folder_target(path: str) -> str:
    if not valid_folder(path):
        raise ValueError("Invalid folder path")
    if sys.platform != "linux" or "microsoft" not in os.uname().release.lower():
        raise NotImplementedError("Open in Explorer is supported only by the local Windows WSL host")
    if not shutil.which("explorer.exe"):
        raise NotImplementedError("Windows File Explorer is not available from this WSL session")
    # Windows Explorer accepts native C:\... and local \\wsl.localhost\...
    # WSL POSIX folders first become a Windows UNC path using the OS converter.
    if path.startswith("/"):
        local = Path(path)
        if not local.is_dir():
            raise FileNotFoundError("Local WSL folder is not accessible")
        converted = subprocess.run(["wslpath", "-w", path], capture_output=True, text=True,
                                   check=True, timeout=5).stdout.strip()
        if not converted or not valid_folder(converted):
            raise ValueError("Windows translation of this WSL folder failed")
        return converted
    if WINDOWS_DRIVE.fullmatch(path):
        converted = subprocess.run(["wslpath", "-u", path], capture_output=True,
                                   text=True, check=True, timeout=5).stdout.strip()
        if not converted or not Path(converted).is_dir():
            raise FileNotFoundError("Local Windows folder is not accessible")
    return path


def open_local_folder(node: dict, shortcut_id: str):
    """Open a persisted L1 folder on the *server's* Windows host, never the remote browser.

    Requires prior HTTP Host/Origin gate. No browser-supplied paths, no shell=True,
    no arbitrary URL handlers, no untrusted SMB UNC hosts.
    """
    if (node.get("kind") not in ROOT_KINDS or node.get("depth") != 1 or
            not isinstance(shortcut_id, str) or not SHORTCUT_ID.fullmatch(shortcut_id)):
        raise ValueError("Folder shortcut must belong to a first-level Work item")
    entries = validate_resource_links(node.get("resourceLinks", []))
    entry = next((entry for entry in entries if entry["id"] == shortcut_id), None)
    if entry is None or entry["kind"] != "folder":
        raise ValueError("Unknown folder shortcut")
    target = _folder_target(entry["target"])
    # No command interpreter or string-based shell. Explicit click launches only
    # the OS Explorer binary; the response does not claim the window appeared.
    subprocess.Popen(["explorer.exe", target], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    return {"requested": True, "destination": "local Windows host"}
