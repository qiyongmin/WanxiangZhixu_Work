"""Static serving helpers for the new Work Shell under ``/app/`` (design 7.1 / 7.2).

Pure functions: ``work_server`` calls ``resolve_app_request`` and decides how to
answer. Nothing here touches the Work store or the network.
"""
from __future__ import annotations
from pathlib import Path, PurePosixPath
from urllib.parse import quote, unquote

ROOT = Path(__file__).resolve().parents[1]
APP_DIR = ROOT / "app"
APP_PREFIX = "/app/"

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-src 'self'; "
       "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
SECURITY_HEADERS = (
    ("Content-Security-Policy", CSP),
    ("X-Content-Type-Options", "nosniff"),
    ("Referrer-Policy", "no-referrer"),
    ("X-Frame-Options", "DENY"),
)
CACHE_NO_STORE = "no-store"
CACHE_IMMUTABLE = "public, max-age=31536000, immutable"
CACHE_REVALIDATE = "no-cache"

FILE, INDEX, MISSING_BUILD, NOT_FOUND = "file", "index", "missing_build", "not_found"


def resolve_app_request(path, app_dir=None):
    """Classify a request path below ``/app/``.

    Returns ``(kind, target)``; ``kind`` is ``file`` (target = file ``Path``),
    ``index`` (target = ``app/index.html``), ``missing_build`` or ``not_found``
    (target ``None``). A path with an extension that does not exist is never
    answered with ``index.html``: the front end would parse HTML as JavaScript.
    """
    base = Path(app_dir) if app_dir is not None else APP_DIR
    if not isinstance(path, str) or not path.startswith(APP_PREFIX):
        return NOT_FOUND, None
    rel = unquote(path[len(APP_PREFIX):].split("?", 1)[0].split("#", 1)[0])
    if "\\" in rel or "\x00" in rel:
        return NOT_FOUND, None
    segments = [s for s in rel.split("/") if s]
    if any(s.startswith(".") for s in segments):      # ".", ".." and hidden files
        return NOT_FOUND, None
    index = base / "index.html"
    if not index.is_file():
        return MISSING_BUILD, None
    if not segments:
        return INDEX, index
    try:
        root = base.resolve()
        target = (base / "/".join(segments)).resolve()
        target.relative_to(root)
    except (ValueError, OSError):
        return NOT_FOUND, None
    if target.is_file():
        return (INDEX if target == index.resolve() else FILE), target
    if PurePosixPath(segments[-1]).suffix == "":
        return INDEX, index                           # client-side route
    return NOT_FOUND, None


def url_for(target, app_dir=None):
    """``/app/…`` URL path of a file returned by ``resolve_app_request``."""
    from urllib.parse import quote
    base = Path(app_dir) if app_dir is not None else APP_DIR
    return APP_PREFIX + quote(Path(target).resolve().relative_to(base.resolve()).as_posix())


def cache_control_for(request_path, status):
    """Cache policy by route class; errors and routes are never cached."""
    if status not in (200, 206):
        return CACHE_NO_STORE
    rel = request_path[len(APP_PREFIX):] if request_path.startswith(APP_PREFIX) else ""
    if rel == "" or rel == "index.html":
        return CACHE_NO_STORE
    if rel.startswith("assets/"):
        return CACHE_IMMUTABLE
    return CACHE_REVALIDATE


def missing_build_page():
    """Script-free Chinese explanation served with HTTP 503 (Req 8.6)."""
    return """<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>新版界面的构建产物缺失</title>
<style>body{font:16px/1.7 system-ui,sans-serif;max-width:42rem;margin:4rem auto;padding:0 1rem;color:#1f2937}
code{background:#f3f4f6;padding:.1rem .35rem;border-radius:4px}a{color:#2563eb}</style>
</head>
<body>
<main>
<h1>新版界面的构建产物缺失</h1>
<p>找不到 <code>app/index.html</code>，所以暂时无法打开新版界面。你的数据没有受到影响。</p>
<ul>
<li>原有 Work 数据仍安全保留。当前仅支持新版 Work Shell，请先恢复 <code>app/</code> 构建产物。</li>
<li>全部 <code>/api/work-hub</code> 与 <code>/api/file-hub</code> 接口仍然可用。</li>
</ul>
<h2>恢复办法</h2>
<ol>
<li>从 Git 恢复 <code>app/</code> 目录；或</li>
<li>在装有 Node 的机器上执行 <code>npm --prefix web ci &amp;&amp; npm --prefix web run build</code>。</li>
</ol>
</main>
</body>
</html>
""".encode("utf-8")


ROOT_META_KEY = "shell.root"
ROOT_CACHE_SECONDS = 2.0
_root_cache = {}


def invalidate_root_cache():
    _root_cache.clear()


def _read_root(db_path):
    """Historical shell.root migration metadata, still readable for backup compatibility.

    The standalone server always routes users to the React Shell; it no longer
    interprets this legacy preference for public page routing.
    """
    import sqlite3
    path = Path(db_path)
    if not path.is_file():
        return False
    try:
        con = sqlite3.connect("file:%s?mode=ro" % quote(path.as_posix()), uri=True)
        try:
            row = con.execute("SELECT value FROM work_meta WHERE key=?", (ROOT_META_KEY,)).fetchone()
        finally:
            con.close()
    except sqlite3.Error:
        return False
    return row is not None and row[0] == "react"


def root_is_shell(db_path=None, now=None):
    """True when ``/`` must redirect to the Shell (``shell.root == 'react'``), cached for 2 s.

    The stored value survives restarts; missing/unmigrated databases answer Legacy.
    """
    import time
    if db_path is None:
        import work_hub_store
        db_path = work_hub_store.DB_PATH
    key = str(db_path)
    stamp = time.monotonic() if now is None else now
    hit = _root_cache.get(key)
    if hit is not None and 0 <= stamp - hit[0] < ROOT_CACHE_SECONDS:
        return hit[1]
    value = _read_root(db_path)
    _root_cache[key] = (stamp, value)
    return value
