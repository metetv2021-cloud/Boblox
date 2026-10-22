#!/usr/bin/env bash
# build.sh — package the client (rbxplay) as a portable single-file AppImage.
#
#   ./tools/appimage/build.sh        # -> build-appimage/Boblox-x86_64.AppImage
#
# Portable whatever distro runs this script: every C/C++ object (OpenSSL,
# libcurl, zstd, ngtcp2, Luau, rbx_runtime, the client) is compiled by Zig's
# bundled clang against glibc 2.28 symbol stubs, with libc++ and every
# library linked statically. The binaries need nothing but glibc >= 2.28
# (Debian 10+, Ubuntu 20.04+, RHEL 8+, current Fedora/Arch/openSUSE), and
# the script refuses to package a binary that asks for more.
#
# All inputs are pinned and checksum-verified, downloaded once into
# $OUT/cache: Zig, OpenSSL (the same 3.5.x as CI, for the native client's
# handshake fingerprint), zstd, curl, nlohmann/json, appimagetool and the
# AppImage runtime. The full ctest battery runs on the Zig build first.
#
# Host needs: bash, curl, tar + xz, cmake >= 3.21, make, perl (OpenSSL's
# Configure), binutils (ar/strip/objdump), python3 + node (test battery).
# No system compiler or -dev packages are used.
#
# Env: OUT=dir (default: ./build-appimage)  JOBS=n  SKIP_TESTS=1
set -euo pipefail
shopt -s inherit_errexit

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
HERE=$ROOT/tools/appimage
OUT=${OUT:-$ROOT/build-appimage}
JOBS=${JOBS:-$(nproc)}
GLIBC=2.28
TARGET=x86_64-linux-gnu.$GLIBC

ZIG_VER=0.16.0
ZIG_URL=https://ziglang.org/download/$ZIG_VER/zig-x86_64-linux-$ZIG_VER.tar.xz
ZIG_SHA=70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00
OPENSSL_VER=3.5.7
OPENSSL_URL=https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VER/openssl-$OPENSSL_VER.tar.gz
OPENSSL_SHA=a8c0d28a529ca480f9f36cf5792e2cd21984552a3c8e4aa11a24aa31aeac98e8
ZSTD_VER=1.5.7
ZSTD_URL=https://github.com/facebook/zstd/releases/download/v$ZSTD_VER/zstd-$ZSTD_VER.tar.gz
ZSTD_SHA=eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3
CURL_VER=8.22.0
CURL_URL=https://github.com/curl/curl/releases/download/curl-${CURL_VER//./_}/curl-$CURL_VER.tar.xz
CURL_SHA=f7ef3ae8a22e521f289803fe93543eb64c329b58aa73a9e224dfd915a2a5f4f7
JSON_VER=3.11.3
JSON_URL=https://github.com/nlohmann/json/releases/download/v$JSON_VER/json.hpp
JSON_SHA=9bea4c8066ef4a1c206b2be5a36302f8926f7fdc6087af5d20b417d0cf103ea6
APPIMAGETOOL_URL=https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage
APPIMAGETOOL_SHA=ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
RUNTIME_URL=https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64
RUNTIME_SHA=2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d

CACHE=$OUT/cache
SRC=$OUT/src
DEPS=$OUT/deps
TOOLS=$OUT/tools
mkdir -p "$CACHE" "$SRC" "$DEPS" "$TOOLS/bin"

GEN=()
if command -v ninja >/dev/null; then GEN=(-G Ninja); fi

log() { printf '\n==> %s\n' "$*"; }

# fetch URL SHA256: download into the cache once, verify, print the path.
fetch() {
  local f=$CACHE/${1##*/}
  if ! { [ -f "$f" ] && echo "$2  $f" | sha256sum -c --status; }; then
    curl -fsSL --retry 3 -o "$f.part" "$1"
    if ! echo "$2  $f.part" | sha256sum -c --status; then
      echo "checksum mismatch: $1" >&2
      rm -f "$f.part"
      exit 1
    fi
    mv "$f.part" "$f"
  fi
  printf '%s\n' "$f"
}

# run LOG CMD...: run quietly into $OUT/LOG; on failure show its tail.
# (Not `if ! cmd`: bash ignores set -e inside a function called there.)
run() {
  local logf=$OUT/$1 rc
  shift
  set +e
  (set -e; "$@") >"$logf" 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    tail -40 "$logf" >&2
    echo "failed ($rc): see $logf" >&2
    exit 1
  fi
}

# A dependency is rebuilt only when its version or the target changes.
built() { [ "$(cat "$DEPS/.$1" 2>/dev/null)" = "$2-$TARGET" ]; }
mark() { echo "$2-$TARGET" >"$DEPS/.$1"; }

# --- toolchain -----------------------------------------------------------------
log "Zig $ZIG_VER -> $TARGET"
ZIG_DIR=$TOOLS/zig-x86_64-linux-$ZIG_VER
if [ ! -x "$ZIG_DIR/zig" ]; then
  tb=$(fetch "$ZIG_URL" "$ZIG_SHA")
  tar -C "$TOOLS" -xJf "$tb"
fi
export ZIG_GLOBAL_CACHE_DIR=$OUT/zig-cache ZIG_LOCAL_CACHE_DIR=$OUT/zig-cache
# Baseline x86-64 (no host-CPU extensions) and no UBSan traps: zig cc turns
# those on for any object compiled without -O.
for tool in cc c++; do
  cat >"$TOOLS/bin/z$tool" <<EOF
#!/bin/sh
exec "$ZIG_DIR/zig" $tool -target $TARGET -mcpu=baseline -fno-sanitize=undefined "\$@"
EOF
  chmod +x "$TOOLS/bin/z$tool"
done
# Exported, not just passed to CMake: the ngtcp2 ExternalProject reads them.
export CC=$TOOLS/bin/zcc CXX=$TOOLS/bin/zc++

# --- static dependencies ---------------------------------------------------------
build_openssl() {
  cd "$SRC/openssl-$OPENSSL_VER"
  # openssldir=/etc/ssl makes the distro trust store OpenSSL's default CA
  # location (AppRun also sets SSL_CERT_FILE); install_dev writes nothing there.
  ./Configure linux-x86_64 no-shared no-dso no-tests no-docs \
    --prefix="$DEPS/openssl" --libdir=lib --openssldir=/etc/ssl CC="$CC"
  make -j"$JOBS" build_libs
  make install_dev
  install -Dm644 LICENSE.txt "$DEPS/openssl/LICENSE"
}
if ! built openssl "$OPENSSL_VER"; then
  log "OpenSSL $OPENSSL_VER"
  tb=$(fetch "$OPENSSL_URL" "$OPENSSL_SHA")
  rm -rf "$SRC/openssl-$OPENSSL_VER" "$DEPS/openssl"
  tar -C "$SRC" -xzf "$tb"
  run openssl.log build_openssl
  mark openssl "$OPENSSL_VER"
fi

build_zstd() {
  make -C "$SRC/zstd-$ZSTD_VER/lib" -j"$JOBS" CC="$CC" PREFIX="$DEPS/zstd" \
    install-static install-includes
  install -Dm644 "$SRC/zstd-$ZSTD_VER/LICENSE" "$DEPS/zstd/LICENSE"
}
if ! built zstd "$ZSTD_VER"; then
  log "zstd $ZSTD_VER"
  tb=$(fetch "$ZSTD_URL" "$ZSTD_SHA")
  rm -rf "$SRC/zstd-$ZSTD_VER" "$DEPS/zstd"
  tar -C "$SRC" -xzf "$tb"
  run zstd.log build_zstd
  mark zstd "$ZSTD_VER"
fi

build_curl() {
  # No compiled-in CA bundle: fall back to OpenSSL's default store, which
  # honors SSL_CERT_FILE (set by AppRun) and openssldir.
  cmake -S "$SRC/curl-$CURL_VER" -B "$OUT/build-curl" "${GEN[@]}" \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER="$CC" \
    -DCMAKE_INSTALL_PREFIX="$DEPS/curl" \
    -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON -DBUILD_CURL_EXE=OFF \
    -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF -DBUILD_LIBCURL_DOCS=OFF \
    -DBUILD_MISC_DOCS=OFF -DENABLE_CURL_MANUAL=OFF \
    -DCURL_USE_OPENSSL=ON -DOPENSSL_ROOT_DIR="$DEPS/openssl" -DOPENSSL_USE_STATIC_LIBS=ON \
    -DCURL_CA_BUNDLE=none -DCURL_CA_PATH=none -DCURL_CA_FALLBACK=ON \
    -DCURL_ZLIB=OFF -DCURL_BROTLI=OFF -DCURL_ZSTD=OFF -DUSE_NGHTTP2=OFF \
    -DUSE_LIBIDN2=OFF -DCURL_USE_LIBPSL=OFF -DCURL_USE_LIBSSH2=OFF \
    -DCURL_USE_GSSAPI=OFF -DCURL_DISABLE_LDAP=ON -DENABLE_ARES=OFF
  cmake --build "$OUT/build-curl" -j "$JOBS"
  cmake --install "$OUT/build-curl"
  install -Dm644 "$SRC/curl-$CURL_VER/COPYING" "$DEPS/curl/LICENSE"
}
if ! built curl "$CURL_VER"; then
  log "curl $CURL_VER"
  tb=$(fetch "$CURL_URL" "$CURL_SHA")
  rm -rf "$SRC/curl-$CURL_VER" "$OUT/build-curl" "$DEPS/curl"
  tar -C "$SRC" -xJf "$tb"
  run curl.log build_curl
  mark curl "$CURL_VER"
fi

tb=$(fetch "$JSON_URL" "$JSON_SHA")
install -Dm644 "$tb" "$DEPS/json/include/nlohmann/json.hpp"

# --- the client ----------------------------------------------------------------------
log "Boblox (Zig clang, static libc++)"
run configure.log cmake -S "$ROOT" -B "$OUT/build" "${GEN[@]}" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" \
  -DOPENSSL_ROOT_DIR="$DEPS/openssl" -DOPENSSL_USE_STATIC_LIBS=ON \
  -DCMAKE_PREFIX_PATH="$DEPS/zstd;$DEPS/curl;$DEPS/json"
run build.log cmake --build "$OUT/build" -j "$JOBS"

if [ "${SKIP_TESTS:-0}" != 1 ]; then
  log "test battery on the Zig build"
  ctest --test-dir "$OUT/build" --output-on-failure
fi

log "portability check (glibc <= $GLIBC, no other shared libraries)"
for b in rbxplay regress9b; do
  bin=$OUT/build/client/$b
  need=$(objdump -T "$bin" | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -Vu | tail -1 || true)
  libs=$(objdump -p "$bin" | awk '/NEEDED/ {print $2}' | tr '\n' ' ')
  echo "$b: needs ${need:-no versioned glibc symbols}; links $libs"
  if [ -n "$need" ] && [ "$(printf '%s\n' "$need" "GLIBC_$GLIBC" | sort -V | tail -1)" != "GLIBC_$GLIBC" ]; then
    echo "error: $b requires $need, newer than GLIBC_$GLIBC" >&2
    exit 1
  fi
  for l in $libs; do
    case $l in
      libc.so.6 | libm.so.6 | libpthread.so.0 | libdl.so.2 | librt.so.1 | ld-linux-x86-64.so.2) ;;
      *) echo "error: $b links $l dynamically" >&2; exit 1 ;;
    esac
  done
done

# --- AppDir + AppImage ------------------------------------------------------------
log "AppDir"
VERSION=$(git -C "$ROOT" describe --always --dirty 2>/dev/null || echo unknown)
APPDIR=$OUT/AppDir
SHARE=$APPDIR/usr/share/boblox
rm -rf "$APPDIR"
install -Dm755 "$HERE/AppRun" "$APPDIR/AppRun"
sed "s/@VERSION@/$VERSION/" "$HERE/boblox.desktop" >"$APPDIR/boblox.desktop"
install -Dm644 "$HERE/boblox.svg" "$APPDIR/boblox.svg"
ln -s boblox.svg "$APPDIR/.DirIcon"
for b in rbxplay regress9b; do
  install -Dm755 "$OUT/build/client/$b" "$APPDIR/usr/bin/$b"
  strip --strip-unneeded "$APPDIR/usr/bin/$b"
done
install -Dm644 "$HERE/openssl.cnf" "$SHARE/openssl.cnf"
echo "$VERSION" >"$SHARE/VERSION"
# rbxplay's 0x90 templates + A7 message (AppRun passes --cap-dir here)
mkdir -p "$SHARE/captures"
cp "$ROOT"/py/captures/*.bin "$SHARE/captures/"
# `selftest`: the regress9b datasets (challenge + native answer + job id)
for d in run/comb_1 run/comb_2 run/comb_3 run/full run/rounds/r1; do
  mkdir -p "$SHARE/selftest/$d"
  cp "$ROOT/$d"/wire_chal*.bin "$ROOT/$d"/wire_ans*.bin "$ROOT/$d/jobid.txt" "$SHARE/selftest/$d/"
done
LIC=$APPDIR/usr/share/licenses/boblox
mkdir -p "$LIC"
for d in openssl zstd curl; do cp "$DEPS/$d/LICENSE" "$LIC/$d.txt"; done
cp "$ROOT/third_party/luau/LICENSE.txt" "$LIC/luau.txt"
cp "$ROOT/third_party/ngtcp2/COPYING" "$LIC/ngtcp2.txt"
sed -n '1,8p' "$DEPS/json/include/nlohmann/json.hpp" >"$LIC/nlohmann-json.txt"
if [ -f "$ZIG_DIR/lib/libcxx/LICENSE.TXT" ]; then cp "$ZIG_DIR/lib/libcxx/LICENSE.TXT" "$LIC/libcxx.txt"; fi

log "AppImage"
AIT=$(fetch "$APPIMAGETOOL_URL" "$APPIMAGETOOL_SHA")
RUNTIME=$(fetch "$RUNTIME_URL" "$RUNTIME_SHA")
chmod +x "$AIT"
IMAGE=$OUT/Boblox-x86_64.AppImage
rm -f "$IMAGE"
# Extract-and-run works without FUSE (containers, CI). The runtime leaves
# its unpacked copy behind, so keep those under $OUT/tmp, not /tmp.
rm -rf "$OUT/tmp"
mkdir -p "$OUT/tmp"
run appimagetool.log env ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 TMPDIR="$OUT/tmp" \
  "$AIT" --no-appstream --runtime-file "$RUNTIME" "$APPDIR" "$IMAGE"

log "smoke test: $IMAGE selftest"
TMPDIR=$OUT/tmp APPIMAGE_EXTRACT_AND_RUN=1 "$IMAGE" selftest
echo
ls -l "$IMAGE"
