#!/usr/bin/env bash
# KB_Work service supervisor: ./start.sh [PORT] [--foreground] [--no-restart] [--browser]
# Defaults to a detached, HEALTH-CHECKED replacement of an existing KB_Work server.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"
if [[ ! -f WORKSPACE_KIND ]] || [[ "$(<WORKSPACE_KIND)" != "KB_WORK_STANDALONE_V1" ]]; then
  echo "Refusing to start: standalone KB_Work marker is missing." >&2
  exit 2
fi
PYTHON="$(command -v python3 || command -v python || true)"
if [[ -z "$PYTHON" ]]; then echo "Python 3 is required." >&2; exit 2; fi
PORT=8001
FOREGROUND=0
RESTART=1
BROWSER=0
for arg in "$@"; do
  case "$arg" in
    --foreground|-f) FOREGROUND=1 ;;
    --no-restart) RESTART=0 ;;
    --browser) BROWSER=1 ;;
    --no-browser) BROWSER=0 ;;
    --help|-h)
      echo "Usage: ./start.sh [PORT] [--foreground] [--no-restart] [--browser]"
      echo "Default: safely stop an existing KB_Work server, start detached, verify readiness."
      exit 0 ;;
    *)
      if [[ "$arg" =~ ^[0-9]+$ ]]; then PORT="$arg"
      else echo "Unknown option: $arg" >&2; exit 2; fi ;;
  esac
done
if (( PORT < 1 || PORT > 65535 )); then echo "Invalid port: $PORT" >&2; exit 2; fi
export KB_SITE_PROFILE=work
# Dual-mode V1.1: standalone stays the default and remains fully offline.
# A Portal-facing adapter must NEVER start before separate pairing/security approval.
case "${KB_WORK_MODE:-local}" in
  local) export KB_WORK_MODE=local ;;
  portal) echo "Portal mode is not approved/implemented; use local mode." >&2; exit 2 ;;
  *) echo "Invalid KB_WORK_MODE (expected local or portal)." >&2; exit 2 ;;
esac
if [[ -n "${KB_WORK_DATA_ROOT:-}" ]]; then
  DATA_ROOT="$("$PYTHON" tools/work_instance_paths.py resolve --path "$KB_WORK_DATA_ROOT")" || exit 2
  "$PYTHON" tools/work_instance_paths.py verify --path "$DATA_ROOT" >/dev/null || exit 2
  export KB_WORK_DATA_ROOT="$DATA_ROOT"
  export KB_FILE_HUB_LIBRARY="$DATA_ROOT/library"
  export KB_FILE_HUB_DATA="$DATA_ROOT/content/file-hub"
  export KB_WORK_HUB_DB="$DATA_ROOT/content/work-hub/work.sqlite3"
  export KB_WORK_HUB_MEDIA="$DATA_ROOT/content/work-hub/media"
else
  # Existing clones and instances retain their exact historical paths.
  export KB_FILE_HUB_LIBRARY="$ROOT/library"
  export KB_FILE_HUB_DATA="$ROOT/content/file-hub"
  export KB_WORK_HUB_DB="$ROOT/content/work-hub/work.sqlite3"
  export KB_WORK_HUB_MEDIA="$ROOT/content/work-hub/media"
fi
export PYTHONUNBUFFERED=1
mkdir -p "$ROOT/.maintenance"
if (( RESTART )); then
  echo "Stopping any verified KB_Work service on port $PORT ..."
  "$ROOT/stop.sh" "$PORT" || { echo "Stop did not finish; refusing to launch a duplicate." >&2; exit 1; }
fi
# Occupied foreign ports are never killed, even with --restart.
if "$PYTHON" "$ROOT/tools/work_server_health.py" "$PORT" --occupied; then
  echo "Port $PORT is still occupied; refusing to start a second server." >&2
  exit 1
fi
ARGS=("$PORT" "--no-browser")
if (( FOREGROUND )); then
  if (( BROWSER )); then ARGS=("$PORT"); fi
  exec "$PYTHON" tools/work_server.py "${ARGS[@]}"
fi
LOG="$ROOT/.maintenance/work-server-$PORT.log"
nohup "$PYTHON" tools/work_server.py "${ARGS[@]}" >>"$LOG" 2>&1 </dev/null &
CHILD=$!
if "$PYTHON" tools/work_server_health.py "$PORT" --wait --expect-pid "$CHILD"; then
  echo "KB_Work ready at http://127.0.0.1:$PORT/app/ (PID $CHILD)"
  echo "Stop: ./stop.sh $PORT  |  Restart: ./start.sh $PORT"
  if (( BROWSER )); then
    "$PYTHON" -m webbrowser "http://127.0.0.1:$PORT/app/" >/dev/null 2>&1 || true
  fi
else
  echo "Start failed or health check timed out; inspect $LOG" >&2
  exit 1
fi
