#!/usr/bin/env bash
set -euo pipefail

# Compatibility wrapper: run the root-level installer from wherever this script lives.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "$REPO_ROOT"
exec "$REPO_ROOT/install.sh" "$@"
