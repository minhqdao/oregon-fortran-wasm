#!/usr/bin/env bash
# Type-checks the hand-written web sources marked // @ts-check, matching the
# CI typecheck job. Requires Node.js; TypeScript is fetched on demand by npx.
set -euo pipefail
cd "$(dirname "$0")/.."

npx -y -p typescript@5.9.2 tsc \
    --noEmit \
    --strict \
    --allowJs \
    --target esnext \
    --module esnext \
    --moduleResolution bundler \
    --lib dom,dom.iterable,esnext \
    web/launcher.js \
    web/runner-protocol.js \
    web/runner.worker.js \
    web/coi-serviceworker.js \
    web/terminal-input.js \
    web/terminal-output.js \
    web/terminal-render.js \
    web/terminal-scroll.js \
    web/terminal-selection.js
