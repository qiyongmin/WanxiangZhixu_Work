# KB_Work Development Guide

For a first-time colleague, begin with [README.md](README.md) (English) or [Windows + WSL2 安装说明](DEPLOYMENT_WINDOWS_WSL_ZH.md) (Chinese). **Validated baseline:** Ubuntu 24.04 under WSL2, Python 3.12, Node.js 22 (>=22.12), optional LibreOffice for Office-to-PDF preview and optional openpyxl for XLSX Sheet Browser. Native Windows Python/Explorer/service shutdown are not yet end-to-end supported; start in WSL, not Windows PowerShell.

## Prepare a clean source-only checkout

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
# Optional Excel Sheet Browser:
python -m pip install openpyxl
npm --prefix web ci
npm --prefix web run build
python tools/work_init.py
python tools/work_doctor.py
./start.sh 8001 --no-browser
```

The initializer starts with **zero Work records**, four Sections, empty File Hub and empty Notes V3 tables. It refuses to overwrite any existing database. The fictional demo is opt-in only: `python3 tools/work_demo.py --confirm-synthetic-demo` on a fresh empty clone.

## Local checks

`python tools/work_doctor.py` is a read-only first-run diagnostic. It reports missing required tools, optional LibreOffice/Excel preview capabilities and the source/build/initialization state. The doctor checks installed cryptography against the documented requirements range and may warn on legacy global Python environments; fresh colleagues should use their own `.venv`. If the app has not been initialized and built yet, `readyToStart=false` is expected.


```bash
python3 tools/work_doctor.py
python3 tools/work_source_audit.py
python3 tools/gitlab_preflight.py
python3 tools/work_release_gate.py
python3 -m unittest tests.test_work_doctor tests.test_work_install_docs tests.test_work_office_headless_smoke tests.test_work_housekeeping tests.test_work_backup_private tests.test_work_v2_fixture -v
python3 -m unittest tests.test_work_gitlab_fresh_clone -v
npm --prefix web run typecheck
npm --prefix web run test
npm --prefix web run build
```

Browser checks must use an independent local fixture or read-only access to port 8001. Write tests **never** write to the live Work/File Hub DB. Test processes must use `./start.sh PORT --foreground --no-restart --no-browser` and terminate that same server process. Never start a detached test server with the default `start.sh` mode.

## Sources and UI

- Edit React source only in `web/src/`; the `app/` folder is generated.
- Add UI components and tests without reviving `js/` or `assets/css/`.
- Preserve Design Tokens, visual styles, Section/Pages layouts, Notes CAS, Materials lineage and deep links. Avoid another version-specific stylesheet when a reusable component rule suffices.
- First verify obsolete assets are genuinely unreferenced; do not use `git clean` as a cleanup method.

## GitLab governance

Only generic Work code and synthetic fixtures may be staged. The local `.gitignore` is a source allowlist, not a substitute for privacy scanning; old GitLab history must not be mirrored to GitHub. See `PUBLIC_RELEASE.md`, `SECURITY.md` and the MIT `LICENSE`.
