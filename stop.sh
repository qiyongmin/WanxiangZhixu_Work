#!/usr/bin/env bash
# Stops only an ownership-verified KB_Work local server. Never kill by port alone.
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
cd "$ROOT"
if [[ ! -f WORKSPACE_KIND ]] || [[ "$(<WORKSPACE_KIND)" != "KB_WORK_STANDALONE_V1" ]]; then
  echo "Refusing to stop: standalone KB_Work marker is missing." >&2; exit 2
fi
PYTHON="$(command -v python3 || command -v python || true)"
if [[ -z "$PYTHON" ]]; then echo "Python 3 is required." >&2; exit 2; fi
exec "$PYTHON" tools/stop_server.py "$@"
