#!/usr/bin/env bash
# Runs the jsdom-based browser smoke tests for web/launcher.js without
# adding a package.json and without putting anything in the repository:
# jsdom lives in a cache directory outside the working tree (override with
# $SMOKE_HOME) and the test finds it through $SMOKE_NODE_MODULES.
set -euo pipefail
cd "$(dirname "$0")/.."

SMOKE_HOME="${SMOKE_HOME:-$HOME/.cache/oregon-fortran-wasm/jsdom-smoke}"

if [ ! -d "$SMOKE_HOME/node_modules/jsdom" ]; then
  echo "installing jsdom into $SMOKE_HOME (one time)..."
  mkdir -p "$SMOKE_HOME"
  npm install --no-save --no-package-lock --prefix "$SMOKE_HOME" --silent jsdom@26
fi

SMOKE_NODE_MODULES="$SMOKE_HOME/node_modules" exec node --test \
    scripts/browser-smoke.test.mjs \
    scripts/boot-guard.test.mjs \
    scripts/terminal-scroll.test.mjs \
    scripts/terminal-keyboard.test.mjs \
    scripts/terminal-log.test.mjs \
    "$@"
