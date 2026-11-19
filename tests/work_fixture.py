"""Temporary workspace fixture and write guard for Work v2 tests.

Rules enforced here (see design 10.1 / 10.2):
  * Tests that write data only ever touch a Temporary_Database or a temporary
    copy of the workspace (directory prefix ``kb-work-test-``).
  * The live ``content/work-hub/work.sqlite3`` is opened read-only (SQLite
    online backup) and is never written; its SHA-256 must be identical before
    and after a test module (``FormalDbGuard``).
  * Nothing here contacts anything except 127.0.0.1.

CLI (used by browser scripts):
  python3 tests/work_fixture.py serve --files light|full [--migrate]
prints one JSON line ``{"port": N, "root": "..."}`` and keeps serving until
stdin is closed, then cleans up and exits 0 (1 when cleanup failed).
"""
from __future__ import annotations

import argparse
import atexit
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / "tools"
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

PREFIX = "kb-work-test-"
FORMAL_DB = ROOT / "content/work-hub/work.sqlite3"
FORMAL_CATALOG = ROOT / "content/file-hub/catalog.sqlite3"
FILE_MODES = ("none", "light", "full")
TOP_FOLDERS = ("Projects", "General", "Shared")


class NonTemporaryDatabase(RuntimeError):
    """Raised before any write when a target database is not a temp copy."""


class CleanupError(RuntimeError):
    """Raised when temporary resources could not be removed."""


# --------------------------------------------------------------------------
# Guard
# --------------------------------------------------------------------------
def _is_under(path: Path, base: Path) -> bool:
    return path == base or base in path.parents


def assert_temp_db(path) -> Path:
    """Return the resolved path, or raise NonTemporaryDatabase.

    Must run *before* any connection is opened so a rejected target is never
    created or modified.
    """
    message = "目标数据库不合规"
    try:
        target = Path(path).resolve()
    except (TypeError, ValueError, OSError) as exc:
        raise NonTemporaryDatabase(f"{message}: {path!r}") from exc
    temp_root = Path(os.path.realpath(tempfile.gettempdir()))
    repo = ROOT.resolve()
    reasons = []
    if temp_root not in target.parents:
        reasons.append("不在系统临时目录之下")
    else:
        relative = target.relative_to(temp_root).parts
        if not any(part.startswith(PREFIX) for part in relative):
            reasons.append("路径中没有 " + PREFIX + " 前缀目录")
    if _is_under(target, repo):
        reasons.append("位于仓库目录之下")
    formal = FORMAL_DB.resolve()
    if target == formal:
        reasons.append("等于正式库")
    elif target.exists() and formal.exists():
        try:
            if os.path.samefile(target, formal):
                reasons.append("与正式库是同一文件")
        except OSError:
            reasons.append("无法确认是否为正式库")
    if reasons:
        raise NonTemporaryDatabase(f"{message}: {target} ({'; '.join(reasons)})")
    return target


_GUARD_STATE = {}


def install_write_guard(store=None):
    """Wrap ``store._connection`` (and ``store.tx`` when present).

    Idempotent. Returns the store module for convenience.
    """
    if store is None:
        import work_hub_store as store  # noqa: WPS433 (tools/ is on sys.path)
    if getattr(store, "_kbw_write_guard", False):
        return store
    original_connection = store._connection

    def guarded_connection(path=None):
        target = Path(path) if path is not None else Path(store.DB_PATH)
        assert_temp_db(target)
        return original_connection(path)

    _GUARD_STATE[id(store)] = {"_connection": original_connection}
    store._connection = guarded_connection
    if hasattr(store, "tx"):
        original_tx = store.tx

        def guarded_tx(path=None, *args, **kwargs):
            target = Path(path) if path is not None else Path(store.DB_PATH)
            assert_temp_db(target)
            return original_tx(path, *args, **kwargs)

        _GUARD_STATE[id(store)]["tx"] = original_tx
        store.tx = guarded_tx
    store._kbw_write_guard = True
    return store


def uninstall_write_guard(store=None):
    if store is None:
        import work_hub_store as store
    saved = _GUARD_STATE.pop(id(store), None)
    if saved is None:
        return
    for name, original in saved.items():
        setattr(store, name, original)
    store._kbw_write_guard = False


def sha256_file(path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


class FormalDbGuard:
    """Asserts the live databases are byte-identical at module end."""

    NAMES = {"work.sqlite3": FORMAL_DB, "catalog.sqlite3": FORMAL_CATALOG}

    def __init__(self):
        self.before = {}

    def start(self):
        self.before = {name: sha256_file(path) for name, path in self.NAMES.items() if path.exists()}
        return self

    def check(self):
        after = {name: sha256_file(path) for name, path in self.NAMES.items() if path.exists()}
        if after != self.before:
            changed = sorted(n for n in set(after) | set(self.before) if after.get(n) != self.before.get(n))
            raise AssertionError("正式库在测试期间被改动: " + ", ".join(changed))


# --------------------------------------------------------------------------
# Temporary workspace
# --------------------------------------------------------------------------
_REGISTRY = []
_REGISTRY_LOCK = threading.Lock()


def _rmtree(path: Path) -> None:
    shutil.rmtree(path)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def _online_copy(src: Path, dst: Path) -> None:
    """Consistent copy of a SQLite file; the source is opened read-only."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    try:
        target = sqlite3.connect(str(dst))
        try:
            source.backup(target)
        finally:
            target.close()
    finally:
        source.close()


def unmigrate_copy(db: Path) -> None:
    """Drop every v2 (``work_*``) object from a *temporary* database copy.

    The v2 migration is purely additive, so removing its tables/indexes returns a
    migrated copy to the pre-migration state tests were written against. The four
    legacy tables are untouched. Never call this on the live database.
    """
    assert_temp_db(db)
    import work_hub_schema as schema
    con = sqlite3.connect(str(db))
    try:
        con.execute("PRAGMA foreign_keys=OFF")
        for index in schema.INDEXES:
            con.execute(f'DROP INDEX IF EXISTS "{index}"')
        # work_* tables only reference legacy tables or work_sections
        for table in reversed(schema.TABLES):
            con.execute(f'DROP TABLE IF EXISTS "{table}"')
        con.commit()
        con.execute("VACUUM")
    finally:
        con.close()
def _copy_tree(src: Path, dst: Path) -> None:
    for walk, dirs, names in os.walk(src, followlinks=False):
        dirs[:] = sorted(d for d in dirs if not (Path(walk) / d).is_symlink())
        base = dst / Path(walk).relative_to(src)
        base.mkdir(parents=True, exist_ok=True)
        for name in sorted(names):
            file = Path(walk) / name
            if file.is_symlink() or name.endswith(("-wal", "-shm")):
                continue
            shutil.copy2(file, base / name)


class TempWorkspace:
    """A throw-away copy of the Work workspace.

    files: ``none``  - source + DB copy only (File Hub creates what it needs)
           ``light`` - plus empty library/{Projects,General,Shared} and
                       content/file-hub/{versions,trash}, content/work-hub/media
           ``full``  - copy of library/, content/file-hub/ (catalog via online
                       backup) and content/work-hub/media/
    The DB copy is normalised to the pre-migration state (v2 ``work_*`` objects
    dropped) unless ``keep_migration=True``; ``migrate=True`` then runs the real
    migration on that copy.
    """

    def __init__(self, files="none", with_db=True, migrate=False, backup_check=None,
                 keep_migration=False):
        if files not in FILE_MODES:
            raise ValueError("files must be one of " + "|".join(FILE_MODES))
        self.files = files
        self.process = None
        self.port = None
        self.closed = False
        self.leftovers = []
        self._log = None
        self.root = Path(tempfile.mkdtemp(prefix=PREFIX)).resolve()
        with _REGISTRY_LOCK:
            _REGISTRY.append(self)
        try:
            self._populate(with_db, keep_migration)
            if migrate:
                self.migrate(backup_check=backup_check)
        except BaseException:
            self.close()
            raise

    # -- construction ------------------------------------------------------
    def _populate(self, with_db, keep_migration=False):
        from gitlab_preflight import source_paths

        names = list(source_paths())
        for name in names:
            src = ROOT / name
            if not src.is_file():
                continue
            dst = self.root / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
        app = ROOT / "app"
        if app.is_dir():
            _copy_tree(app, self.root / "app")
        if with_db and FORMAL_DB.exists():
            _online_copy(FORMAL_DB, self.db_path)
            if not keep_migration:
                # Deterministic pre-migration state whatever the live DB's state is.
                unmigrate_copy(self.db_path)
        else:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        (self.root / "content/work-hub/media").mkdir(parents=True, exist_ok=True)
        if self.files in ("light", "full"):
            for top in TOP_FOLDERS:
                (self.root / "library" / top).mkdir(parents=True, exist_ok=True)
            for sub in ("versions", "trash"):
                (self.root / "content/file-hub" / sub).mkdir(parents=True, exist_ok=True)
        if self.files == "full":
            self._copy_full()

    def _copy_full(self):
        library = ROOT / "library"
        if library.is_dir():
            _copy_tree(library, self.root / "library")
        hub = ROOT / "content/file-hub"
        if hub.is_dir():
            _copy_tree(hub, self.root / "content/file-hub")
            # The raw main file may miss WAL content; replace with a consistent copy.
            if FORMAL_CATALOG.exists():
                (self.root / "content/file-hub/catalog.sqlite3").unlink(missing_ok=True)
                _online_copy(FORMAL_CATALOG, self.root / "content/file-hub/catalog.sqlite3")
        media = ROOT / "content/work-hub/media"
        if media.is_dir():
            _copy_tree(media, self.root / "content/work-hub/media")

    @property
    def db_path(self) -> Path:
        return self.root / "content/work-hub/work.sqlite3"

    # -- operations --------------------------------------------------------
    def migrate(self, backup_check=None):
        """Run the (Phase 1) migration on the *copy*; stub gate allowed here only."""
        assert_temp_db(self.db_path)
        try:
            import work_migrate
        except ImportError as exc:  # pragma: no cover - Phase 1 module
            raise RuntimeError("work_migrate is not available yet (Phase 1)") from exc
        return work_migrate.migrate(db_path=self.db_path,
                                    backup_check=backup_check or (lambda *a, **k: True))

    def serve(self, timeout=30.0):
        if self.process is not None:
            raise RuntimeError("workspace already serving")
        port = free_port()
        env = {k: v for k, v in os.environ.items() if not k.startswith("KB_")}
        env["PYTHONUNBUFFERED"] = "1"
        self._log = open(self.root / "serve.log", "wb")
        self.process = subprocess.Popen(
            ["bash", "./start.sh", str(port), "--foreground", "--no-restart", "--no-browser"],
            cwd=self.root, env=env, stdin=subprocess.DEVNULL,
            stdout=self._log, stderr=subprocess.STDOUT, start_new_session=True)
        self.port = port
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError("副本服务启动失败: " + self.read_log()[-1200:])
            try:
                with urllib.request.urlopen(self.url("/api/server-info"), timeout=2) as reply:
                    if reply.status == 200:
                        return self.url("")
            except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
                time.sleep(0.1)
        self.stop()
        raise RuntimeError("副本服务启动超时")

    def url(self, path="/") -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def read_log(self) -> str:
        try:
            return (self.root / "serve.log").read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def stop(self):
        process, self.process = self.process, None
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    process.kill()
                process.wait(timeout=8)
        if self._log is not None:
            self._log.close()
            self._log = None

    def close(self):
        """Stop the server and remove the directory; records what failed."""
        self.stop()
        self.leftovers = []
        if self.root.exists():
            try:
                _rmtree(self.root)
            except OSError as exc:
                self.leftovers.append(f"{self.root} ({exc})")
            if self.root.exists() and not self.leftovers:
                self.leftovers.append(str(self.root))
        if not self.leftovers:
            self.closed = True
            with _REGISTRY_LOCK:
                if self in _REGISTRY:
                    _REGISTRY.remove(self)
        return not self.leftovers

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()


def verify_cleanup() -> None:
    """Close every workspace still registered; raise if any resource remains."""
    with _REGISTRY_LOCK:
        pending = list(_REGISTRY)
    leftovers = []
    for workspace in pending:
        if not workspace.close():
            leftovers.extend(workspace.leftovers)
    if leftovers:
        raise CleanupError("无法清理的临时资源: " + "; ".join(leftovers))


def stray_dirs() -> list:
    """Directories with the test prefix in the system temp dir (diagnostics)."""
    base = Path(os.path.realpath(tempfile.gettempdir()))
    return sorted(str(p) for p in base.glob(PREFIX + "*"))


def _atexit_cleanup():
    with _REGISTRY_LOCK:
        pending = list(_REGISTRY)
    for workspace in pending:
        try:
            workspace.close()
        except Exception:  # noqa: BLE001 - best effort at interpreter exit
            pass


atexit.register(_atexit_cleanup)


# --------------------------------------------------------------------------
# Shared helper for characterization / contract fixtures
# --------------------------------------------------------------------------
class Normalizer:
    """Replace timestamps / generated ids / event ids with stable placeholders.

    Embedded JSON snapshots (``before_json`` / ``after_json``) are parsed first
    because they carry timestamps of their own.
    """

    TS = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?\+00:00$")
    GEN_ID = re.compile(r"work-[0-9a-f]{32}")

    def __init__(self):
        self.generated = {}

    def __call__(self, value):
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if key == "event_id" and isinstance(item, str):
                    result[key] = "<event>"
                elif key in ("before_json", "after_json") and isinstance(item, str):
                    result[key] = self(json.loads(item))
                else:
                    result[key] = self(item)
            return result
        if isinstance(value, (list, tuple)):
            return [self(v) for v in value]
        if isinstance(value, str):
            if self.TS.match(value):
                return "<ts>"
            return self.GEN_ID.sub(self._gen, value)
        return value

    def _gen(self, match):
        return self.generated.setdefault(match.group(0), f"<generated-id-{len(self.generated) + 1}>")


# --------------------------------------------------------------------------
# CLI for browser scripts
# --------------------------------------------------------------------------
def _cli(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Serve a temporary Work workspace copy")
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--files", choices=FILE_MODES, default="light")
    serve.add_argument("--migrate", action="store_true")
    args = parser.parse_args(argv)
    guard = FormalDbGuard().start()
    workspace = TempWorkspace(files=args.files, migrate=args.migrate)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    try:
        workspace.serve()
        print(json.dumps({"port": workspace.port, "root": str(workspace.root)}), flush=True)
        # Block until the parent closes stdin (or SIGTERM arrives).
        reader = threading.Thread(target=lambda: (sys.stdin.read(), stop.set()), daemon=True)
        reader.start()
        stop.wait()
    finally:
        ok = workspace.close()
    try:
        guard.check()
    except AssertionError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if not ok:
        print("cleanup failed: " + "; ".join(workspace.leftovers), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
