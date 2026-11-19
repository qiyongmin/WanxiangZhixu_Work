"""KB_Site deployment boundary. Separate runtime profiles; combined remains legacy-compatible.

This is a routing/storage guard, NOT user authentication. Never make a corporate
Work profile internet-facing without a corporate-approved identity gateway.
"""
from __future__ import annotations

import copy
import os
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
WORK_RELEASE = (ROOT / 'WORKSPACE_KIND').is_file() and (ROOT / 'WORKSPACE_KIND').read_text(encoding='utf-8').strip() == 'KB_WORK_STANDALONE_V1'
PROFILE = os.environ.get('KB_SITE_PROFILE', 'work' if WORK_RELEASE else 'combined').strip().lower()
if PROFILE not in ({'work'} if WORK_RELEASE else {'combined','personal','work'}):
    raise ValueError('This standalone Work workspace permits only KB_SITE_PROFILE=work' if WORK_RELEASE else 'Invalid KB_SITE_PROFILE')

# No profile may accidentally expose private data through the static file server.
PRIVATE_STATIC_TOP = {"content", "library", "projects", "tools", "tests", ".agents", ".spec",
                      ".maintenance", ".backups", "node_modules", "%SystemDrive%"}
PERSONAL_DENIED = ("projects/", "data/domains/work", "data/review/work", "data/project-skills.json",
                   "js/viz/work-hub", "assets/css/work-hub",
                   "demos/work-command-center",
                   "media/work/", "docs/")
WORK_DENIED = ("data/domains/english", "data/domains/math", "data/domains/ai",
               "data/domains/geography", "data/domains/history",
               "data/domains/physics", "data/domains/inspiration",
               "media/personal/", "assets/images/", "assets/news/",
               "assets/videos/")

def static_allowed(path: str) -> bool:
    decoded = unquote(urlsplit(path).path).lstrip("/")
    parts = Path(decoded).parts
    if not parts:
        return True
    if any(p in {".", ".."} or p.startswith(".") for p in parts):
        return False
    if parts[0] in PRIVATE_STATIC_TOP:
        return False
    if PROFILE == "personal":
        return not decoded.startswith(PERSONAL_DENIED)
    if PROFILE == "work":
        # Retired V1 application code must not be served after single-Shell
        # cutover. These assets remain in a reversible source archive until
        # the verified cleanup stage; /app/assets is a separate React build.
        if WORK_RELEASE and decoded.startswith(("js/", "assets/css/", "assets/vendor/")):
            return False
        return not decoded.startswith(WORK_DENIED)
    return True

def api_allowed(path: str) -> bool:
    path = urlsplit(path).path
    if not path.startswith('/api/'):
        return True
    if PROFILE == "combined":
        return True
    if path == "/api/project-backup":
        # The legacy one-click ZIP mixes Work, personal, and File Hub data.
        return False
    if path.startswith("/api/file-hub"):
        # Only activate a File Hub after BOTH isolated roots are explicitly set.
        return bool(os.environ.get("KB_FILE_HUB_LIBRARY") and os.environ.get("KB_FILE_HUB_DATA"))
    if PROFILE == "personal":
        return not path.startswith("/api/work-hub")
    # The Work server permits its own APIs and File Hub; not personal knowledge.
    return path.startswith(("/api/work-hub", "/api/file-hub", "/api/server-info", "/api/resources/v1"))

def filtered_index(source: dict) -> dict:
    if PROFILE == "combined":
        return source
    result = copy.deepcopy(source)
    result['deploymentProfile'] = PROFILE
    domain_ids = {"work"} if PROFILE == "work" else {
        d.get("id") for d in result.get("domains", []) if d.get("id") != "work"
    }
    result["domains"] = [d for d in result.get("domains", []) if d.get("id") in domain_ids]
    result["collections"] = [
        dict(c, domainIds=[i for i in c.get("domainIds", []) if i in domain_ids])
        for c in result.get("collections", [])
        if any(i in domain_ids for i in c.get("domainIds", []))
    ]
    return result

def filtered_review_index(source: dict) -> dict:
    if PROFILE == "combined": return source
    result=copy.deepcopy(source)
    allow=lambda d: d.get("id")=="work" if PROFILE=="work" else d.get("id")!="work"
    result["domains"]=[d for d in result.get("domains",[]) if allow(d)]
    return result

def validate_isolated_runtime() -> None:
    if PROFILE == "combined":
        return
    # This marker is generated only in the separately assembled Work release.
    # It allows its own work-only File Hub paths, never paths under KB_Site.
    if WORK_RELEASE:
        # Explicit optional Data Root; unset means the original standalone
        # source-root layout. Validate the whole instance before serving.
        external = os.environ.get('KB_WORK_DATA_ROOT')
        if external:
            import work_instance_paths
            base = work_instance_paths.resolve(external)
            work_instance_paths.verify(base)
        else:
            base = ROOT
        expected={
          'KB_FILE_HUB_LIBRARY':base/'library',
          'KB_FILE_HUB_DATA':base/'content/file-hub',
          'KB_WORK_HUB_DB':base/'content/work-hub/work.sqlite3',
          'KB_WORK_HUB_MEDIA':base/'content/work-hub/media',
        }
        for name,destination in expected.items():
            value=os.environ.get(name)
            if not value or Path(value).resolve()!=destination.resolve():
                raise ValueError(f'Standalone Work must use its own {name}: {destination}')
        return
    # Prevent declaring a separated service while still using the shared mixed
    # File Hub catalog / Work Hub database. Legacy default is untouched.
    for name in ("KB_FILE_HUB_LIBRARY", "KB_FILE_HUB_DATA"):
        if not os.environ.get(name):
            raise ValueError(f"{PROFILE} mode requires an isolated {name} path")
    root = ROOT.resolve()
    for name in ("KB_FILE_HUB_LIBRARY", "KB_FILE_HUB_DATA"):
        resolved = Path(os.environ[name]).resolve()
        if resolved in {root / "library", root / "content" / "file-hub"}:
            raise ValueError(f"{name} cannot point to the legacy mixed File Hub")
    if PROFILE == "work":
        work_db = os.environ.get("KB_WORK_HUB_DB")
        if not work_db:
            raise ValueError("work mode requires a dedicated KB_WORK_HUB_DB")
        if Path(work_db).resolve() == root / "content" / "work-hub" / "work.sqlite3":
            raise ValueError("work mode cannot use the legacy Work Hub DB")
