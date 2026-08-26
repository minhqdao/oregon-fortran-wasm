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
# Toolchain resolution (first match wins, resolved independently per tool):
#   1. $LFORTRAN / $EMCC overrides
#   2. tools/ (a previous provisioning run or a manual checkout)
#   3. lfortran / emcc on PATH
#   4. automatic provisioning into tools/ at pinned versions:
#        - LFortran $LFORTRAN_VERSION, installed from conda-forge into
#          tools/lfortran (bootstrapped via micromamba).  LFortran publishes
#          no binary releases and a source build requires LLVM, so the
#          prebuilt conda-forge package is the only practical channel.
#        - Emscripten $EMSCRIPTEN_VERSION, via the emsdk repository checked
#          out at tools/emsdk.
#      Provisioning needs: git, curl, tar, and bzip2.  emsdk additionally
#      requires Python 3.10+; if the system has none, a Python is fetched
#      from conda-forge as well.

set -euo pipefail
cd "$(dirname "$0")/.."

LFORTRAN_VERSION="0.64.0"
EMSCRIPTEN_VERSION="6.0.8"
MICROMAMBA_VERSION="2.9.0"
TOOLS_DIR="$PWD/tools"

require_command() {
    if ! command -v "$1" > /dev/null; then
        echo "error: '$1' is required to provision the toolchain but was not found" >&2
        exit 1
    fi
}

mamba_platform() {
    case "$(uname -s)-$(uname -m)" in
        Darwin-arm64)              echo osx-arm64 ;;
        Darwin-x86_64)             echo osx-64 ;;
        Linux-x86_64|Linux-amd64)  echo linux-64 ;;
        Linux-aarch64|Linux-arm64) echo linux-aarch64 ;;
        *) return 1 ;;
    esac
}

bootstrap_micromamba() {
    if [[ -x "$TOOLS_DIR/bin/micromamba" ]]; then
        return 0
    fi

    local platform
    if ! platform="$(mamba_platform)"; then
        return 1
    fi

    require_command curl
    require_command tar
    require_command bzip2
    mkdir -p "$TOOLS_DIR/bin"
    curl -Ls "https://micro.mamba.pm/api/micromamba/$platform/$MICROMAMBA_VERSION" \
        | tar -xj -C "$TOOLS_DIR" bin/micromamba
}

# emsdk refuses to run on Python < 3.10, and a bare macOS system only offers
# the Xcode command-line tools' python3 (3.9).  Probe the usual candidates
# and, failing that, fetch a Python from conda-forge via micromamba.
find_python() {
    local candidate
    for candidate in \
        python3 python3.13 python3.12 python3.11 python3.10 \
        /opt/homebrew/bin/python3 /usr/local/bin/python3; do
        if command -v "$candidate" > /dev/null || [[ -x "$candidate" ]]; then
            if "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))' 2> /dev/null; then
                echo "$candidate"
                return 0
            fi
        fi
    done

    if bootstrap_micromamba && [[ -x "$TOOLS_DIR/bin/micromamba" ]]; then
        if [[ ! -x "$TOOLS_DIR/python/bin/python3" ]]; then
            echo "==> No Python 3.10+ found; provisioning one from conda-forge into tools/python" >&2
            "$TOOLS_DIR/bin/micromamba" create --no-rc -y \
                -r "$TOOLS_DIR/micromamba" \
                -p "$TOOLS_DIR/python" \
                -c conda-forge \
                "python=3.12" >&2 || return 1
        fi
        echo "$TOOLS_DIR/python/bin/python3"
        return 0
    fi

    return 1
}

provision_lfortran() {
    echo "==> Provisioning LFortran $LFORTRAN_VERSION from conda-forge into tools/lfortran"

    if [[ -e tools/lfortran && ! -d tools/lfortran/conda-meta ]]; then
        echo "error: tools/lfortran exists but is not a conda environment; remove it or set \$LFORTRAN" >&2
        exit 1
    fi

    if ! bootstrap_micromamba; then
        echo "error: no prebuilt LFortran available for $(uname -s)-$(uname -m); install lfortran and set \$LFORTRAN" >&2
        exit 1
    fi

    # The root prefix keeps micromamba's package cache inside tools/ as well.
    # Re-running this against an existing environment resumes a previously
    # interrupted provisioning run.  --no-rc ignores the user's conda
    # configuration so channel resolution stays deterministic.
    "$TOOLS_DIR/bin/micromamba" create --no-rc -y \
        -r "$TOOLS_DIR/micromamba" \
        -p "$TOOLS_DIR/lfortran" \
        -c conda-forge \
        "lfortran=$LFORTRAN_VERSION"
}

provision_emsdk() {
    echo "==> Provisioning Emscripten $EMSCRIPTEN_VERSION via emsdk into tools/emsdk"
    require_command git

    local python
    if ! python="$(find_python)"; then
        echo "error: emsdk requires Python 3.10 or newer but none could be found or provisioned; install it, or set \$EMCC to an existing emcc" >&2
        exit 1
    fi

    if [[ -e tools/emsdk && ! -d tools/emsdk/.git ]]; then
        echo "error: tools/emsdk exists but is not a git checkout; remove it or set \$EMCC" >&2
        exit 1
    fi

    if [[ ! -d tools/emsdk/.git ]]; then
        git clone --quiet -c advice.detachedHead=false \
            --branch "$EMSCRIPTEN_VERSION" --depth 1 \
            https://github.com/emscripten-core/emsdk.git tools/emsdk
    fi

    # Re-running install/activate resumes a previously interrupted run.
    # emsdk is a shell wrapper that picks its interpreter from $EMSDK_PYTHON.
    EMSDK_PYTHON="$python" "$TOOLS_DIR/emsdk/emsdk" install "$EMSCRIPTEN_VERSION"
    EMSDK_PYTHON="$python" "$TOOLS_DIR/emsdk/emsdk" activate "$EMSCRIPTEN_VERSION"
}

if [[ -z "${LFORTRAN:-}" ]]; then
    if [[ -x tools/lfortran/src/bin/lfortran ]]; then
        # Layout of a from-source build of the lfortran repository.
        LFORTRAN="$PWD/tools/lfortran/src/bin/lfortran"
    elif [[ -x tools/lfortran/bin/lfortran ]]; then
        # Layout of the provisioned conda-forge environment.
        LFORTRAN="$PWD/tools/lfortran/bin/lfortran"
    elif command -v lfortran > /dev/null; then
        LFORTRAN="lfortran"
    else
        provision_lfortran
        LFORTRAN="$PWD/tools/lfortran/bin/lfortran"
    fi
fi

if [[ -z "${EMCC:-}" ]]; then
    if [[ -x tools/emsdk/upstream/emscripten/emcc ]]; then
        EMCC="$PWD/tools/emsdk/upstream/emscripten/emcc"
    elif command -v emcc > /dev/null; then
        EMCC="emcc"
    else
        provision_emsdk
        EMCC="$PWD/tools/emsdk/upstream/emscripten/emcc"
    fi
fi

if [[ "$EMCC" == "$PWD/tools/emsdk/upstream/emscripten/emcc" ]]; then
    # emsdk's emcc needs a modern Python; prefer the interpreter bundled by
    # emsdk over whatever python3 happens to be on PATH.
    if [[ -z "${EMSDK_PYTHON:-}" ]]; then
        bundled_python="$(find tools/emsdk/python -maxdepth 3 -name 'python3*' -type f ! -name '*config*' 2>/dev/null | sort | tail -1)"
        if [[ -n "$bundled_python" ]]; then
            export EMSDK_PYTHON="$PWD/$bundled_python"
        fi
    fi
fi

BUILD_DIR="${BUILD_DIR:-build}"

if ! command -v "$LFORTRAN" > /dev/null; then
    echo "error: lfortran not found at $LFORTRAN" >&2
    exit 1
fi
if ! command -v "$EMCC" > /dev/null; then
    echo "error: emcc not found at $EMCC" >&2
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
