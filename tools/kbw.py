#!/usr/bin/env python3
"""kbw: Agent_CLI for the Work command center (design section 8).

Standard library only. It talks to the local Work server over HTTP (``/api/work-hub/agent/*``)
and nothing else: it imports no Work Hub server module and never opens a database file.

Exit codes: 0 success, 1 API answered 4xx (or refused a redirect), 2 local usage error,
3 connection failure or timeout, 4 API answered 5xx. On any failure stdout stays empty and
stderr carries ``HTTP <status> <code>: <message>`` (``details`` as JSON on the next line).
"""
import argparse
import http.client
import json
import os
import sys
import threading
import urllib.parse
from pathlib import Path

DEFAULT_URL = "http://127.0.0.1:8001"
TIMEOUT = 30                       # seconds; module level so tests can shorten it
MAX_FILE_BYTES = 10 * 1024 * 1024
LOCAL_HOSTS = ("127.0.0.1", "localhost")
CONNECT_HOST = "127.0.0.1"         # always the literal address, never a name that DNS / hosts could redirect
CLIENT_NAME = "kbw/1"
API = "/api/work-hub/agent/"
FORMATS = {".md": "md", ".markdown": "md", ".html": "html", ".htm": "html"}


class UsageError(Exception):
    """A local problem: nothing was sent. Exit code 2."""


# --------------------------------------------------------------------------
# Command line
# --------------------------------------------------------------------------
def build_parser():
    parser = argparse.ArgumentParser(prog="kbw", description="Agent_CLI for the Work command center")
    parser.add_argument("--base-url", default=None, help="local server URL (default: $KB_WORK_URL or %s)" % DEFAULT_URL)
    sub = parser.add_subparsers(dest="command", required=True)

    def add(name, help_text, write):
        command = sub.add_parser(name, help=help_text)
        command.set_defaults(write=write)
        if write:
            command.add_argument("--actor", default=None, help="who is writing, e.g. agent:kiro (required)")
        return command

    def node_args(command, flag="--node", required=True):
        command.add_argument(flag, required=required, help="node ID or Node_Path")

    command = add("node", "read one node", False)
    node_args(command)
    command = add("children", "list children of a node", False)
    node_args(command)
    command.add_argument("--limit", type=int)
    command.add_argument("--offset", type=int)
    command = add("search", "search nodes", False)
    command.add_argument("--query", required=True)
    command.add_argument("--limit", type=int)
    command.add_argument("--offset", type=int)
    command.add_argument("--section")
    command = add("add-note", "add a Note (Unconfirmed until the user confirms)", True)
    node_args(command)
    command.add_argument("--base-revision", type=int)
    command.add_argument("--title", required=True)
    group = command.add_mutually_exclusive_group(required=True)
    group.add_argument("--markdown")
    group.add_argument("--markdown-file")
    group.add_argument("--html-file")
    command = add("add-material", "link a file or a web page", True)
    node_args(command)
    command.add_argument("--base-revision", type=int)
    command.add_argument("--type", required=True, choices=("link", "file"))
    command.add_argument("--title")
    command.add_argument("--url")
    command.add_argument("--file-id")
    command = add("upload-report", "upload a Markdown / HTML report", True)
    node_args(command)
    command.add_argument("--base-revision", type=int)
    command.add_argument("--title", required=True)
    command.add_argument("--file", required=True)
    command.add_argument("--format", choices=("md", "html"))
    command = add("set-summary", "replace the Summary_Block", True)
    node_args(command)
    command.add_argument("--base-revision", type=int)
    group = command.add_mutually_exclusive_group(required=True)
    group.add_argument("--markdown")
    group.add_argument("--markdown-file")
    command = add("add-task", "add a Task (always Planned)", True)
    command.add_argument("--parent", required=True, help="parent node ID or Node_Path")
    command.add_argument("--title", required=True)
    command.add_argument("--description")
    command.add_argument("--priority")
    command.add_argument("--tag", action="append", default=None)
    command.add_argument("--base-revision", type=int)
    command = add("propose", "submit a Change_Proposal for human-owned fields", True)
    node_args(command)
    command.add_argument("--base-revision", type=int)
    command.add_argument("--changes", required=True, help="JSON object, e.g. '{\"status\":\"Blocked\"}'")
    command.add_argument("--rationale", required=True)
    command.add_argument("--evidence", action="append", default=None)
    command = add("proposal-status", "read the state of a Change_Proposal", False)
    command.add_argument("--id", required=True)
    return parser


# --------------------------------------------------------------------------
# Local validation
# --------------------------------------------------------------------------
def local_endpoint(base_url):
    """``(port)`` for a loopback ``http`` URL; anything else is a usage error (Req 25.7)."""
    try:
        parts = urllib.parse.urlsplit(base_url)
        port = parts.port or 80
        host = (parts.hostname or "").lower()
    except ValueError:
        raise UsageError("无效的 --base-url: %s（仅允许本机地址 127.0.0.1 或 localhost）" % base_url) from None
    if parts.scheme.lower() != "http" or host not in LOCAL_HOSTS or parts.username is not None \
            or parts.password is not None or parts.path not in ("", "/") or parts.query or parts.fragment:
        raise UsageError("--base-url 仅允许本机地址（http://127.0.0.1[:端口] 或 http://localhost[:端口]）: %s" % base_url)
    return port


def read_text_file(path, label="文件"):
    file = Path(path)
    try:
        if not file.is_file():
            raise UsageError("%s不存在或不是文件: %s" % (label, path))
        if file.stat().st_size > MAX_FILE_BYTES:
            raise UsageError("%s超过 10 MiB: %s" % (label, path))
        return file.read_text(encoding="utf-8")
    except UsageError:
        raise
    except (OSError, UnicodeError) as exc:
        raise UsageError("无法读取%s %s: %s" % (label, path, exc)) from None


def build_request(args):
    """``(method, path, body)`` for a parsed command line; may raise ``UsageError``."""
    command = args.command
    if command == "node":
        return "GET", API + "node?" + urllib.parse.urlencode({"node": args.node}), None
    if command == "children":
        return "GET", API + "children?" + _query({"node": args.node, "limit": args.limit, "offset": args.offset}), None
    if command == "search":
        return "GET", API + "search?" + _query({"q": args.query, "limit": args.limit, "offset": args.offset,
                                                "section": args.section}), None
    if command == "proposal-status":
        return "GET", API + "proposal?" + urllib.parse.urlencode({"id": args.id}), None
    body = {"actor": args.actor.strip()}
    if getattr(args, "base_revision", None) is not None:
        body["baseRevision"] = args.base_revision
    if command == "add-note":
        body.update(node=args.node, title=args.title)
        if args.markdown is not None:
            body["markdown"] = args.markdown
        elif args.markdown_file:
            body["markdown"] = read_text_file(args.markdown_file)
        else:
            body["html"] = read_text_file(args.html_file)
        return "POST", API + "note", body
    if command == "add-material":
        body.update(node=args.node, type=args.type)
        if args.title:
            body["title"] = args.title
        if args.type == "link":
            if not args.url:
                raise UsageError("--type link 需要 --url")
            body["url"] = args.url
        else:
            if not args.file_id:
                raise UsageError("--type file 需要 --file-id")
            body["fileId"] = args.file_id
        return "POST", API + "material", body
    if command == "upload-report":
        content = read_text_file(args.file, "报告文件")
        fmt = args.format or FORMATS.get(Path(args.file).suffix.lower())
        if fmt is None:
            raise UsageError("无法从扩展名判断格式，请使用 --format md|html: %s" % args.file)
        body.update(node=args.node, title=args.title, format=fmt, content=content)
        return "POST", API + "report", body
    if command == "set-summary":
        text = args.markdown if args.markdown is not None else read_text_file(args.markdown_file)
        body.update(node=args.node, markdown=text)
        return "POST", API + "summary", body
    if command == "add-task":
        body.update(node=args.parent, title=args.title)
        for key, value in (("description", args.description), ("priority", args.priority), ("tags", args.tag)):
            if value is not None:
                body[key] = value
        return "POST", API + "task", body
    if command == "propose":
        try:
            changes = json.loads(args.changes)
        except ValueError as exc:
            raise UsageError("--changes 不是有效的 JSON: %s" % exc) from None
        if not isinstance(changes, dict):
            raise UsageError("--changes 必须是 JSON 对象")
        body.update(node=args.node, changes=changes, rationale=args.rationale, evidence=args.evidence or [])
        return "POST", API + "proposal", body
    raise UsageError("未知子命令: %s" % command)


def _query(values):
    return urllib.parse.urlencode({k: v for k, v in values.items() if v is not None})


# --------------------------------------------------------------------------
# Transport
# --------------------------------------------------------------------------
def send(port, method, path, body):
    """Run the request in a daemon thread; ``(status, raw)`` or ``("timeout"|"error", message)``."""
    outcome = {}
    host_header = "%s:%d" % (CONNECT_HOST, port)
    headers = {"Host": host_header, "Origin": "http://" + host_header, "X-Work-Client": CLIENT_NAME,
               "Accept": "application/json"}
    token = os.environ.get("KB_WORK_HUB_AGENT_TOKEN")
    if token:
        headers["X-Work-Hub-Agent-Key"] = token
    payload = None
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"

    def work():
        connection = http.client.HTTPConnection(CONNECT_HOST, port, timeout=TIMEOUT + 5)
        try:
            connection.request(method, path, body=payload, headers=headers)
            reply = connection.getresponse()
            outcome["result"] = (reply.status, reply.read())      # redirects are never followed
        except TimeoutError:
            outcome["timeout"] = True
        except (OSError, http.client.HTTPException) as exc:
            outcome["error"] = str(exc) or exc.__class__.__name__
        finally:
            connection.close()

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    thread.join(TIMEOUT)
    if thread.is_alive() or outcome.get("timeout"):
        return "timeout", "请求超时（%d 秒）" % TIMEOUT
    if "error" in outcome:
        return "error", "无法连接到 %s: %s" % (host_header, outcome["error"])
    return outcome["result"]


def report_failure(status, raw):
    """Write ``HTTP <status> <code>: <message>`` (+ details) to stderr; return the exit code."""
    code, message, details = "error", "", None
    try:
        payload = json.loads(raw)
        if isinstance(payload, dict):
            code = str(payload.get("code") or "error")
            message = str(payload.get("error") or "")
            details = payload.get("details")
    except ValueError:
        message = raw[:200].decode("utf-8", "replace").strip()
    if 300 <= status < 400:
        code, message = "redirect_refused", "服务器返回重定向，已拒绝跟随"
    print("HTTP %d %s: %s" % (status, code, message), file=sys.stderr)
    if details:
        print(json.dumps(details, ensure_ascii=False), file=sys.stderr)
    return 4 if status >= 500 else 1


def main(argv=None):
    requested = list(sys.argv[1:] if argv is None else argv)
    if requested and requested[0] == 'resources':
        import work_resources_cli
        return work_resources_cli.main(requested[1:])
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    args = build_parser().parse_args(argv)             # argparse itself exits with status 2
    try:
        if args.write and not (args.actor or "").strip():
            raise UsageError("缺少 --actor 参数（写入类命令必须明确声明 Actor，例如 --actor agent:kiro）")
        port = local_endpoint(args.base_url or os.environ.get("KB_WORK_URL") or DEFAULT_URL)
        method, path, body = build_request(args)
    except UsageError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    status, raw = send(port, method, path, body)
    if status in ("timeout", "error"):
        print(raw, file=sys.stderr)
        return 3
    if not 200 <= status < 300:
        return report_failure(status, raw)
    try:
        payload = json.loads(raw)
        data = payload["data"]
    except (ValueError, KeyError, TypeError):
        print("HTTP %d invalid_response: 服务器返回了无法解析的响应" % status, file=sys.stderr)
        return 4
    print(json.dumps(data, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
