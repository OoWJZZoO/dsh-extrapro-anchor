#!/usr/bin/env bash
# Build the self-contained `preset/` directory: the composition rows reference
# ./lib/*.js, so this script snapshots the current plugin sources into
# preset/lib/ (single source of truth stays at repo root lib/). Run after any
# lib/ change before shipping the preset.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p preset/lib
cp lib/index.js lib/runtime.js lib/guards.js preset/lib/
echo "preset/lib updated: $(ls preset/lib)"
