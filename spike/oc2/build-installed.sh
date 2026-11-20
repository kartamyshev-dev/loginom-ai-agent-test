#!/bin/sh
# B0.4: an installed build of the sandbox (U1, U3, U5 with its Desktop seam) with upstream's own build scripts.
# Usage: build-installed.sh linux|windows
#   linux   → .run/b0-installed/dist-linux/opencode-desktop-linux-x86_64.AppImage
#   windows → .run/b0-installed/dist-windows/win-unpacked: the unpacked Windows app, cross-built here without wine.
#             The NSIS installer itself cannot be made here without wine: electron-builder runs it under wine to extract
#             the uninstaller. B0.4b builds the installer on the stand instead (installed-windows.sh), from the same
#             scripts and config; the stand's upload link is too slow to carry this 360 MB app over.
# Bun 1.4.4, the version upstream pins (@opencode/script refuses 1.4.3), lands in .run/cache with its SHA-256 checked.
# Caches of Bun compile targets, electron-builder toolsets and Electron go to .run/cache too. Logs: .run/b0-installed/<os>/.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
os=${1:?usage: build-installed.sh linux|windows}
run=$here/.run/b0-installed
cache=$here/.run/cache
desktop=$here/opencode/packages/desktop
mkdir -p "$run/$os" "$cache/bun-1.4.4"

if [ ! -x "$cache/bun-1.4.4/bun-linux-x64/bun" ]; then
  base=https://github.com/oven-sh/bun/releases/download/bun-v1.4.4
  curl -fsSL -o "$cache/bun-1.4.4/bun-linux-x64.zip" "$base/bun-linux-x64.zip"
  expected=$(curl -fsSL "$base/SHASUMS256.txt" | grep ' bun-linux-x64.zip$' | cut -d' ' -f1)
  [ "$(sha256sum "$cache/bun-1.4.4/bun-linux-x64.zip" | cut -d' ' -f1)" = "$expected" ] || { echo "Bun checksum mismatch" >&2; exit 1; }
  (cd "$cache/bun-1.4.4" && unzip -oq bun-linux-x64.zip && rm bun-linux-x64.zip)
fi
export PATH="$cache/bun-1.4.4/bun-linux-x64:$PATH"
export BUN_INSTALL_CACHE_DIR="$cache/bun-install" ELECTRON_BUILDER_CACHE="$cache/electron-builder" electron_config_cache="$cache/electron"
# The CLI takes the `latest` channel and the Desktop `prod`, as a release does. U5 replaces the registration file and port
# that the channel would pick. The update feed is overridden in harness/electron-builder.spike.ts.
export OPENCODE_VERSION=2.3.0-b04

if [ "$os" = linux ]; then cli=linux-x64-baseline target=linux-x64 install=--skip-install exe=opencode-cli
else cli=windows-x64-baseline target=windows-x64 install= exe=opencode-cli.exe; fi

# The bundled CLI: upstream's build with the product plugin compiled in through core/src/plugin/loginom-product. The web UI
# is skipped: the Desktop sets OPENCODE_DISABLE_EMBEDDED_WEB_UI. For Windows the build first installs every platform's
# native packages (`bun install --os=* --cpu=*`), which also brings @lydell/node-pty-win32-x64 for the Desktop.
(cd "$here/opencode/packages/cli" && OPENCODE_CHANNEL=latest OPENCODE_TARGET=$cli /usr/bin/time -v bun script/build.ts --skip-web-ui $install) \
  > "$run/$os/cli-build.log" 2>&1

# The Desktop's main bundle names the node-pty package of OPENCODE_TARGET, so out/ is rebuilt per target. script/build.ts
# copies the CLI as resources/opencode-cli by the host's naming, so the Windows one is renamed.
rm -f "$desktop/resources/opencode-cli" "$desktop/resources/opencode-cli.exe" "$desktop/resources/opencode-cli.version"
(cd "$desktop" && OPENCODE_CHANNEL=prod OPENCODE_TARGET=$target /usr/bin/time -v bun run script/build.ts) > "$run/$os/desktop-build.log" 2>&1
[ "$os" = windows ] && mv "$desktop/resources/opencode-cli" "$desktop/resources/opencode-cli.exe"
ls -l "$desktop/resources/$exe"

export OPENCODE_CHANNEL=prod OPENCODE_TARGET=$target B0_DIST="$run/dist-$os"
rm -rf "$B0_DIST"
if [ "$os" = linux ]; then
  (cd "$desktop" && B0_ELECTRON_DIST="$desktop/node_modules/electron/dist" /usr/bin/time -v \
    bunx electron-builder --linux AppImage --x64 --publish never --config "$here/harness/electron-builder.spike.ts") > "$run/$os/builder.log" 2>&1
  ls -l "$B0_DIST"/*.AppImage
  exit 0
fi

(cd "$desktop" && /usr/bin/time -v bunx electron-builder --win --x64 --dir --publish never --config "$here/harness/electron-builder.spike.ts") \
  > "$run/$os/builder-dir.log" 2>&1
ls -l "$B0_DIST/win-unpacked"
