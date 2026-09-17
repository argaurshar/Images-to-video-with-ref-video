#!/usr/bin/env bash
# Start the ArchViz Cinematic Engine.
#
# Binds to localhost normally, but to 0.0.0.0 inside a container or a
# Codespace, where the port has to be reachable from outside the container for
# the forwarded URL to work at all.
set -euo pipefail
cd "$(dirname "$0")"

if [ -n "${CODESPACES:-}" ] || [ -n "${ARCHVIZ_BIND_ALL:-}" ] || [ -f /.dockerenv ]; then
  HOST_DEFAULT=0.0.0.0
else
  HOST_DEFAULT=127.0.0.1
fi

exec uvicorn backend.app.main:app \
  --host "${HOST:-$HOST_DEFAULT}" \
  --port "${PORT:-8000}" \
  --workers 1 \
  "$@"
