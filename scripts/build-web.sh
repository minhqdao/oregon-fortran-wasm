#!/usr/bin/env bash
#
# Builds web/oregon.js and web/oregon.wasm with a single LFortran
# (>= 0.69.0) invocation: 0.69.0 forwards Emscripten -s settings to the emcc
# link it runs for --target=wasm32-unknown-emscripten (#16268) and finds its
# own runtime object.
#
# Both sources stay separate: the only cross-file call is OREGON_TIME(),
# which takes no arguments, so its implicit-interface prototype matches.
# (The sibling Colossal Cave port has argument-taking external shims and
# must concatenate its sources into one compilation unit.)
#
# Needs lfortran >= 0.69.0 on PATH ($LFORTRAN) and Emscripten via EMSDK_PATH,
# else EMSDK, else emcc on PATH (shimmed below).

set -euo pipefail
cd "$(dirname "$0")/.."

LFORTRAN="${LFORTRAN:-lfortran}"
SHIM_ROOT=""

cleanup() {
    if [[ -n "$SHIM_ROOT" ]]; then rm -rf "$SHIM_ROOT"; fi
}
trap cleanup EXIT

if ! command -v "$LFORTRAN" > /dev/null; then
    echo "error: lfortran not found (install LFortran >= 0.69.0 and add it to your PATH, or set \$LFORTRAN)" >&2
    exit 1
fi
if [[ -z "${EMSDK_PATH:-}" || ! -x "${EMSDK_PATH%/}/upstream/emscripten/emcc" ]]; then
    if [[ -n "${EMSDK:-}" && -x "${EMSDK%/}/upstream/emscripten/emcc" ]]; then
        export EMSDK_PATH="${EMSDK%/}"
    elif command -v emcc > /dev/null; then
        EMCC_BIN="$(command -v emcc)"
        SHIM_ROOT="$(mktemp -d)"
        EMSDK_PATH="$SHIM_ROOT/shim"
        mkdir -p "$EMSDK_PATH/upstream/emscripten"
        printf '#!/bin/sh\nexec %q "$@"\n' "$EMCC_BIN" > "$EMSDK_PATH/upstream/emscripten/emcc"
        chmod +x "$EMSDK_PATH/upstream/emscripten/emcc"
        export EMSDK_PATH
    else
        echo "error: no Emscripten found (set EMSDK_PATH to an emsdk root, or put emcc on PATH)" >&2
        exit 1
    fi
fi

# 4 MB initial / 32 MB max grown memory. Colossal Cave's port history is a
# series of iOS crashes caused by eager linear-memory reservation: a fixed
# 256 MB start aborted on reload under WebContent memory pressure, and even
# a 16 MB start exhausted a small-RAM iPhone after a few refreshes (iOS
# reclaims the previous page's memory lazily, so refreshes overlap). A
# scripted playthrough of the sibling port never grows past the 4 MB start;
# the reservation fits within one small page while 32 MB remains a generous
# ceiling. The 1 MB stack keeps >10x headroom over the ~64 KB peak observed
# with stack-overflow checking enabled. Oregon's screens and tables are
# comparable in size; STACK_OVERFLOW_CHECK stays on to catch a regression.
"$LFORTRAN" \
    --fixed-form \
    --implicit-interface \
    --implicit-typing \
    --target=wasm32-unknown-emscripten \
    -sSTACK_SIZE=1mb \
    -sINITIAL_MEMORY=4mb \
    -sMAXIMUM_MEMORY=32mb \
    -sALLOW_MEMORY_GROWTH=1 \
    -sSTACK_OVERFLOW_CHECK=1 \
    -sEXIT_RUNTIME=1 \
    -sMODULARIZE \
    -sEXPORT_ES6 \
    -sEXPORTED_RUNTIME_METHODS=FS,callMain \
    src/oregon.f src/oregon_time.f \
    -o web/oregon.js

# wasm-ld only warns about invalid modules, so fail the build here instead
# of shipping an artifact that aborts at WebAssembly.instantiate().
node -e 'const fs = require("node:fs"); if (!WebAssembly.validate(fs.readFileSync("web/oregon.wasm"))) { console.error("error: generated WebAssembly module does not validate"); process.exit(1); }'

echo "Built web/oregon.js and web/oregon.wasm"
