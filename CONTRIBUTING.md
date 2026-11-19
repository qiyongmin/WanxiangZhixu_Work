# Contributing to KB_Work (Public Source)

The intended destination is a public GitHub source-only repository under the [MIT License](LICENSE).

1. Start from the [deployment README](README.md) or the [Chinese Windows + WSL2 installation guide](DEPLOYMENT_WINDOWS_WSL_ZH.md). Install Python 3.12 + Node 22 inside WSL2/Ubuntu (recommended on Windows), then clone the authorized source, install dependencies, build, run `python tools/work_init.py` for a fresh zero-data database, and check `python tools/work_doctor.py`. LibreOffice is recommended for high-fidelity read-only Office PDF preview; `openpyxl` is optional for XLSX Sheet Browser.
2. Never submit `content/`, `library/`, `projects/`, `.backups/`, generated `app/`, personal `AGENTS.md`, live API keys or individual Work Notes.
3. Keep examples **completely synthetic**. Use `tools/work_demo.py` if available to generate optional fake records. Never export real workplace materials to make fixtures.
4. Run `python3 tools/work_source_audit.py`, `python3 -m unittest tests.test_work_doctor -v`, scoped Python tests, `npm --prefix web run typecheck`, frontend tests, and `npm --prefix web run build`. Native Windows Python/Explorer/stop operations remain unsupported pending their own platform acceptance.
5. Submit a GitHub Pull Request with scope, test evidence, data compatibility and rollback notes. Never change Node/Material/Note IDs or weaken Revision/CAS safety.
6. Review third-party dependency licenses, staged files and source privacy; a passing CI run does not make an unauthenticated localhost service safe for shared deployment.

