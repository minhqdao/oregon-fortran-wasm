#!/usr/bin/env bash
#
# Bundles the web launcher into a deployable dist/ directory.
#
# GitHub Pages serves everything with a fixed max-age=600, so a deploy can be
# observed with a stale launcher.js and a fresh terminal-*.js module graph,
# which fails instantiation with "SyntaxError: Importing binding name ... is
# not found" before any launcher code runs. Bundling collapses the whole
# import graph (launcher + worker) into one self-contained launcher.js and
# one runner.worker.js, so each is cached atomically: always entirely stale
# or entirely fresh, never mixed. A query-string build id busts the fixed
# max-age after deploys. esbuild runs with --packages=external because the
# sources import no npm packages; the only external reference kept is the
# wasm URL built from import.meta.url, which the worker resolves at runtime.
#
# Usage: scripts/bundle-web.sh [--out DIR]
#   --out DIR   output directory (default: dist)
#
# Requires esbuild from PATH or at $ESBUILD (the CI job installs it via npm).

set -euo pipefail
cd "$(dirname "$0")/.."

ESBUILD="${ESBUILD:-esbuild}"
OUT_DIR="dist"

if ! command -v "$ESBUILD" > /dev/null; then
    echo "error: esbuild not found (set \$ESBUILD or install it)" >&2
    exit 1
fi

while [[ $# -gt 0 ]]; do
    case "$1" in
        --out) OUT_DIR="$2"; shift 2 ;;
        *) echo "error: unknown argument: $1" >&2; exit 1 ;;
    esac
done

# Deterministic per-commit id: any content change to the *bundled* sources
# flips it, so a fresh deploy's HTML references URLs no browser has cached
# yet and fetches the new bundle instead of serving the old one from
# max-age. The file list must cover the full esbuild import graph (launcher
# + worker): the modules that get inlined but are not named here would let a
# change slip through with a stale cached bundle -- the exact skew the
# versioned entry exists to prevent.
BUILD_ID="$( (git rev-parse HEAD 2> /dev/null || true; \
    cat web/index.html web/coi-serviceworker.js web/launcher.js \
        web/runner.worker.js web/runner-protocol.js web/oregon.js \
        web/terminal-input.js web/terminal-keyboard.js web/terminal-log.js \
        web/terminal-output.js web/terminal-render.js web/terminal-scroll.js \
        web/terminal-selection.js 2> /dev/null) \
    | shasum -a 256 | cut -d' ' -f1 | cut -c1-12 )"

mkdir -p "$OUT_DIR"

cp web/index.html "$OUT_DIR/index.html"

# The inline boot guard must run before the launcher for the module-load
# phase to be observable at all.
sed -i.bak "s|src=\"./launcher.js\"|src=\"./launcher.js?v=$BUILD_ID\"|" "$OUT_DIR/index.html"
rm -f "$OUT_DIR/index.html.bak"

# Scope of the bust (deliberate): only the entry is versioned. Resolving
# ./runner.worker.js or ./oregon.js against launcher.js?v=ID DROPS the
# query (relative URL resolution discards the base query), so those keep
# stable URLs and their own max-age windows. That is still atomic in
# practice: both bundles are self-contained, and the glue + wasm pair is
# fetched within milliseconds of the same boot, so their near-identical
# expiry means they mix as consistently old or consistently fresh pairs.
# Do not "propagate" the query to the glue URL: the glue derives its wasm
# URL from its own import.meta.url the same way, so a versioned glue with
# an unversioned wasm would create a real fresh-glue/stale-wasm hazard
# that does not exist today.

"$ESBUILD" web/launcher.js \
    --bundle \
    --format=esm \
    --target=es2020 \
    --outfile="$OUT_DIR/launcher.js" \
    --packages=external \
    --legal-comments=none

"$ESBUILD" web/runner.worker.js \
    --bundle \
    --format=esm \
    --target=es2020 \
    --outfile="$OUT_DIR/runner.worker.js" \
    --packages=external \
    --legal-comments=none

cp web/oregon.js web/oregon.wasm "$OUT_DIR/"
cp web/coi-serviceworker.js "$OUT_DIR/"
cp web/favicon.ico web/favicon.svg web/favicon-16.png web/favicon-32.png \
    web/favicon-64.png web/apple-touch-icon.png "$OUT_DIR/"

echo "Bundled web/ into $OUT_DIR/ (build id: $BUILD_ID)"
