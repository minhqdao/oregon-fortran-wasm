#!/usr/bin/env bash
#
# Builds the browser artifacts web/oregon.js and web/oregon.wasm from the
# FORTRAN 77 sources using LFortran (compile) and Emscripten (link).
#
# LFortran's own Emscripten link step cannot carry `-s` settings (they are
# silently dropped), so the sources are compiled to object files with lfortran
# and linked with emcc, which adds -sMODULARIZE/-sEXPORT_ES6 so the runner
# worker can import the module factory as an ES module.
#
# Requirements:
#   - lfortran (auto-detected in tools/lfortran/src/bin, or override with $LFORTRAN)
#   - emcc (auto-detected in tools/emsdk/upstream/emscripten, or override with $EMCC)
#
# The LFortran WASM runtime object (lfortran_runtime_wasm_emcc.o) is located
# relative to the lfortran binary; set LFORTRAN_RUNTIME_LIBRARY_DIR to point
# at it directly.

set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -z "${LFORTRAN:-}" && -x tools/lfortran/src/bin/lfortran ]]; then
    LFORTRAN="$PWD/tools/lfortran/src/bin/lfortran"
fi
if [[ -z "${EMCC:-}" && -x tools/emsdk/upstream/emscripten/emcc ]]; then
    EMCC="$PWD/tools/emsdk/upstream/emscripten/emcc"
    # emsdk's emcc needs a modern Python; prefer the interpreter bundled by
    # emsdk over whatever python3 happens to be on PATH.
    if [[ -z "${EMSDK_PYTHON:-}" ]]; then
        bundled_python="$(find tools/emsdk/python -maxdepth 3 -name 'python3*' -type f ! -name '*config*' 2>/dev/null | sort | tail -1)"
        if [[ -n "$bundled_python" ]]; then
            export EMSDK_PYTHON="$PWD/$bundled_python"
        fi
    fi
fi
LFORTRAN="${LFORTRAN:-lfortran}"
EMCC="${EMCC:-emcc}"
BUILD_DIR="${BUILD_DIR:-build}"

if ! command -v "$LFORTRAN" > /dev/null; then
    echo "error: lfortran not found (set \$LFORTRAN, e.g. LFORTRAN=tools/lfortran/src/bin/lfortran)" >&2
    exit 1
fi
if ! command -v "$EMCC" > /dev/null; then
    echo "error: emcc not found (set \$EMCC, or run 'source <emsdk>/emsdk_env.sh' first)" >&2
    exit 1
fi

FFLAGS=(
    --fixed-form
    --implicit-interface
    --implicit-typing
    --target=wasm32-unknown-emscripten
)

find_runtime_object() {
    if [[ -n "${LFORTRAN_RUNTIME_LIBRARY_DIR:-}" ]]; then
        echo "${LFORTRAN_RUNTIME_LIBRARY_DIR%/}/lfortran_runtime_wasm_emcc.o"
        return
    fi

    local bin_dir prefix candidate
    bin_dir="$(cd "$(dirname "$(command -v "$LFORTRAN")")" && pwd)"
    prefix="$(dirname "$bin_dir")"
    for candidate in \
        "$prefix/share/lfortran/lib/lfortran_runtime_wasm_emcc.o" \
        "$prefix/lib/lfortran_runtime_wasm_emcc.o" \
        "$prefix/runtime/lfortran_runtime_wasm_emcc.o"; do
        if [[ -f "$candidate" ]]; then
            echo "$candidate"
            return
        fi
    done

    echo "error: lfortran_runtime_wasm_emcc.o not found (searched relative to $bin_dir; set LFORTRAN_RUNTIME_LIBRARY_DIR)" >&2
    return 1
}

RUNTIME_OBJECT="$(find_runtime_object)"

mkdir -p "$BUILD_DIR"

"$LFORTRAN" -c "${FFLAGS[@]}" -J "$BUILD_DIR" \
    src/oregon.f -o "$BUILD_DIR/oregon.o"
"$LFORTRAN" -c "${FFLAGS[@]}" -J "$BUILD_DIR" \
    src/oregon_time.f -o "$BUILD_DIR/oregon_time.o"

"$EMCC" \
    --target=wasm32-unknown-emscripten \
    -sSTACK_SIZE=50mb \
    -sINITIAL_MEMORY=256mb \
    -sMODULARIZE \
    -sEXPORT_ES6 \
    -sEXPORTED_RUNTIME_METHODS=FS,callMain \
    "$BUILD_DIR/oregon.o" \
    "$BUILD_DIR/oregon_time.o" \
    "$RUNTIME_OBJECT" \
    -o web/oregon.js

echo "Built web/oregon.js and web/oregon.wasm (runtime: $RUNTIME_OBJECT)"
