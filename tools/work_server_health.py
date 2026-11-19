"""Loopback-only KB_Work service readiness & foreign-port guard.

Usage: python3 tools/work_server_health.py PORT --occupied
       python3 tools/work_server_health.py PORT --wait [--expect-pid PID]
Exit 0 only for the expected state; never stop processes.
"""
from __future__ import annotations
import argparse
import json
import socket
import time
import urllib.error
import urllib.request


def occupied(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.35):
            return True
    except OSError:
        return False


def info(port: int):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/server-info",
                                     headers={"Accept": "application/json"})
    try:
        with opener.open(request, timeout=0.8) as response:
            payload = json.load(response)
        if not isinstance(payload, dict) or payload.get("ok") is not True:
            return None
        if payload.get("profile") != "work":
            return None
        data = payload.get("data")
        if not isinstance(data, dict) or data.get("workspace") != "KB_WORK_STANDALONE_V1":
            return None
        return data
    except (OSError, ValueError, urllib.error.URLError, TimeoutError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description="KB_Work local health")
    parser.add_argument("port", type=int)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--occupied", action="store_true")
    group.add_argument("--wait", action="store_true")
    parser.add_argument("--expect-pid", type=int)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("Invalid port")
    if args.occupied:
        return 0 if occupied(args.port) else 1
    for _ in range(100):
        status = info(args.port)
        if status and status.get("port") == args.port:
            if args.expect_pid is None or status.get("pid") == args.expect_pid:
                print(json.dumps({"ok": True, "port": args.port, "pid": status["pid"],
                                  "workspace": status["workspace"]}))
                return 0
        time.sleep(0.1)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
