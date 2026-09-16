#!/usr/bin/env bash
# Start the ArchViz Cinematic Engine locally (mock provider unless ARCHVIZ_PROVIDER is set).
set -euo pipefail
cd "$(dirname "$0")"
exec uvicorn backend.app.main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}" "$@"
