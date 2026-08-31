#!/usr/bin/env bash
# Runs the jsdom-based browser tests without adding a package.json and
# without putting anything in the repository: jsdom lives in a cache
# directory outside the working tree (override with $SMOKE_HOME) and the
# tests find it through $SMOKE_NODE_MODULES.
#
# Only the boot-guard suite runs here: the launcher's touch-gesture tests
# exercise colossal-cave-wasm's native-scroll keyboard model, which this
# project deliberately does not use (the terminal constrains itself above
# the soft keyboard instead).
set -euo pipefail
cd "$(dirname "$0")/.."

SMOKE_HOME="${SMOKE_HOME:-$HOME/.cache/oregon-fortran-wasm/jsdom-smoke}"

if [ ! -d "$SMOKE_HOME/node_modules/jsdom" ]; then
  echo "installing jsdom into $SMOKE_HOME (one time)..."
  mkdir -p "$SMOKE_HOME"
  npm install --no-save --no-package-lock --prefix "$SMOKE_HOME" --silent jsdom@26
fi

SMOKE_NODE_MODULES="$SMOKE_HOME/node_modules" exec node --test \
    scripts/boot-guard.test.mjs \
    "$@"
