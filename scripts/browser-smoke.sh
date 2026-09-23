#!/usr/bin/env bash
# Runs the jsdom-based browser smoke tests for web/launcher.js.
# jsdom comes from the root node_modules (npm install); when it is missing
# (e.g. a checkout without installed dependencies) it falls back to a cache
# directory outside the working tree (override with $SMOKE_HOME). The test
# finds jsdom through $SMOKE_NODE_MODULES.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -d "node_modules/jsdom" ]; then
  SMOKE_NODE_MODULES="$PWD/node_modules"
else
  SMOKE_HOME="${SMOKE_HOME:-$HOME/.cache/oregon-fortran-wasm/jsdom-smoke}"

  if [ ! -d "$SMOKE_HOME/node_modules/jsdom" ]; then
    echo "installing jsdom into $SMOKE_HOME (one time)..."
    mkdir -p "$SMOKE_HOME"
    npm install --no-save --no-package-lock --prefix "$SMOKE_HOME" --silent jsdom@26
  fi

  SMOKE_NODE_MODULES="$SMOKE_HOME/node_modules"
fi

SMOKE_NODE_MODULES="$SMOKE_NODE_MODULES" exec node --test \
    scripts/browser-smoke.test.mjs \
    scripts/boot-guard.test.mjs \
    "$@"
