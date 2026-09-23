#!/usr/bin/env bash
# Type-checks the hand-written web sources marked // @ts-check, matching the
# CI typecheck job. Requires Node.js; TypeScript is fetched on demand by npx.
# --maxNodeModuleJsDepth lets tsc infer the terminal-shell npm package's
# JSDoc types instead of reporting TS7016 (missing declaration file); the
# package ships no .d.ts, so without it the bare imports are untyped.
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
    --maxNodeModuleJsDepth 2 \
    web/launcher.js \
    web/runner.worker.js \
    web/coi-serviceworker.js
