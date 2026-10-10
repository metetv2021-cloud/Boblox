#!/usr/bin/env bash
# Build the browser module and/or the native reference CLI.
#
#   ./web/build.sh            # WebAssembly -> web/dist/boblox_engine.{mjs,wasm}
#   ./web/build.sh native     # native CLI  -> web/build-native/boblox_cli
#   ./web/build.sh all        # both
#
# The WebAssembly build needs Emscripten on PATH (developed and tested on
# 4.0.23) — `source /path/to/emsdk/emsdk_env.sh` first. Everything else comes from
# the repo's pinned submodules:  git submodule update --init third_party/luau
#
# Extra CMake arguments pass through after the target:
#   ./web/build.sh wasm -DCMAKE_BUILD_TYPE=Debug -DBOBLOX_WASM_EXCEPTIONS=js
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WHAT="${1:-wasm}"
[ $# -gt 0 ] && shift

if [ ! -f "$ROOT/third_party/luau/CMakeLists.txt" ]; then
    echo "error: Luau submodule missing. Run: git submodule update --init third_party/luau" >&2
    exit 1
fi

GENERATOR=()
command -v ninja >/dev/null 2>&1 && GENERATOR=(-G Ninja)
JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"

build_wasm() {
    if ! command -v emcmake >/dev/null 2>&1; then
        echo "error: emcmake not found. Install Emscripten and source emsdk_env.sh first." >&2
        echo "       https://emscripten.org/docs/getting_started/downloads.html" >&2
        exit 1
    fi
    emcmake cmake -S "$ROOT/web" -B "$ROOT/web/build-wasm" "${GENERATOR[@]}" \
        -DCMAKE_BUILD_TYPE=Release "$@"
    cmake --build "$ROOT/web/build-wasm" -j"$JOBS"
    echo
    ls -l "$ROOT/web/dist/boblox_engine.mjs" "$ROOT/web/dist/boblox_engine.wasm"
}

build_native() {
    cmake -S "$ROOT/web" -B "$ROOT/web/build-native" "${GENERATOR[@]}" \
        -DCMAKE_BUILD_TYPE=Release "$@"
    cmake --build "$ROOT/web/build-native" -j"$JOBS"
    echo
    ls -l "$ROOT/web/build-native/boblox_cli"
}

case "$WHAT" in
    wasm) build_wasm "$@" ;;
    native) build_native "$@" ;;
    all) build_native "$@"; build_wasm "$@" ;;
    *) echo "usage: $0 [wasm|native|all] [cmake args...]" >&2; exit 2 ;;
esac
