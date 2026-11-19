"""Stop only a verified KB_Work loopback server from this checkout.

The PID file alone never authorizes termination. Requires a process matching
the Work root+entrypoint and the occupied local port. No force kill or pkill.
"""
from __future__ import annotations
import argparse
import json
import os
import signal
import socket
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def pid_path(port):
    return ROOT / ".maintenance" / f"server-{port}.pid.json"


def is_alive(pid):
    try:
        stat = Path(f"/proc/{pid}/stat")
        if stat.exists() and len(stat.read_text().split()) > 2 and stat.read_text().split()[2] == "Z":
            return False
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, FileNotFoundError):
        return False
    except PermissionError:
        return True


def port_occupied(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.35):
            return True
    except OSError:
        return False


def server_info(port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(f"http://127.0.0.1:{port}/api/server-info", timeout=0.9) as response:
            body = json.load(response)
        if body.get("ok") is not True or body.get("profile") != "work":
            return None
        return body.get("data") if isinstance(body.get("data"), dict) else {}
    except (OSError, ValueError):
        return None


def process_matches(pid, port):
    """Only trust exact root and Python Work entrypoint. /proc is Linux/WSL."""
    proc = Path(f"/proc/{pid}")
    try:
        cwd = proc.joinpath("cwd").resolve(strict=True)
        args = [value.decode(errors="replace") for value in
                proc.joinpath("cmdline").read_bytes().split(b"\0") if value]
    except (OSError, PermissionError):
        return False
    if cwd != ROOT.resolve() or not any(v == "tools/work_server.py" for v in args):
        return False
    entries = [v for v in args if v.isdigit() and 1 <= int(v) <= 65535]
    return int(entries[0]) == port if entries else port == 8001


def matching_processes(port):
    procroot = Path("/proc")
    if not procroot.is_dir():
        return []
    return [int(p.name) for p in procroot.iterdir() if p.name.isdigit() and
            process_matches(int(p.name), port)]


def verified_record(port):
    info = server_info(port)
    if info is None:  # foreign process or unresponsive Work port: no kill
        return None
    path = pid_path(port)
    if path.is_file():
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
            pid = record.get("pid")
            if (type(pid) is int and record.get("port") == port and
                    Path(record.get("root", "")).resolve() == ROOT.resolve() and
                    process_matches(pid, port) and
                    (not info or (info.get("pid") == pid and
                      info.get("token") == record.get("token")))):
                return record
        except (ValueError, TypeError, OSError):
            pass
    # Old KB_Work server-info lacked the PID/token payload; /proc proof is
    # still enough when exactly one matching Work process serves this port.
    if info and info.get("workspace") != "KB_WORK_STANDALONE_V1":
        return None
    candidates = matching_processes(port)
    if len(candidates) == 1 and not info:
        return {"pid": candidates[0], "port": port, "legacy": True}
    return None


def main():
    parser = argparse.ArgumentParser(description="Safely stop this checkout's local KB_Work server")
    parser.add_argument("port", nargs="?", type=int, default=8001)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Port out of range")
    record = verified_record(args.port)
    if record is None:
        if port_occupied(args.port):
            print(f"Port {args.port} is occupied but ownership is not verified; no process was stopped.")
            return 2
        print(f"No KB_Work service is running on port {args.port}.")
        path = pid_path(args.port)
        if path.is_file():
            try:
                stale = json.loads(path.read_text(encoding="utf-8"))
                if not is_alive(int(stale.get("pid", -1))):
                    path.unlink(missing_ok=True)
            except (OSError, ValueError, TypeError):
                pass
        return 0
    pid = int(record["pid"])
    if not process_matches(pid, args.port):  # reject PID reuse just before kill
        print("PID ownership changed; refusing to terminate.")
        return 2
    try:
        os.kill(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    # Stop succeeds only when both process and its listening socket are gone.
    for _ in range(100):
        if not is_alive(pid) and not port_occupied(args.port):
            pid_path(args.port).unlink(missing_ok=True)
            print(f"KB_Work stopped (PID {pid}, port {args.port}).")
            return 0
        time.sleep(0.1)
    print(f"KB_Work process {pid} or port {args.port} did not shut down cleanly; no force kill.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
