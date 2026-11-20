#!/bin/sh
# B0.4b from Linux: the NSIS installer is built on the stand (installed-windows.ps1), installed, checked and removed there.
# Usage: installed-windows.sh <ssh-alias> [copy|setup|build|run|fetch|clean]...   (default: copy setup build run fetch)
# copy  — the overlay over the v2.3.0 tag (files the patches change, the product plugin, the tag's symlinks as plain
#         files; ~140 KB) and the harness. The stand fetches the source, packages, Electron and NSIS itself.
# fetch — report, snapshots, logs and screenshots into .run/b0-installed/windows/stand/. clean removes the stand folder.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
host=$1
shift
root='C:\lab\b0-installed'
remote=$(printf '%s' "$root" | tr '\\' /)
run=$here/.run/b0-installed
# Legacy scp protocol (-O), as the 0.4 smoke uses for this stand.
cp_to() { scp -O -o BatchMode=yes -q "$@"; }
ps() { ssh -o BatchMode=yes -o ServerAliveInterval=30 "$host" "powershell -NoProfile -ExecutionPolicy Bypass -File \"$root\\installed-windows.ps1\" -Root \"$root\" -Action $1"; }
[ $# -gt 0 ] || set -- copy setup build run fetch
for step in "$@"; do
  case $step in
    copy)
      overlay=$run/overlay
      rm -rf "$overlay" && mkdir -p "$overlay"
      # Changed and new files of the sandbox (tag + patches/*.patch + plugin link) and the tag's symlinks, dereferenced.
      (cd "$here/opencode" && { git diff --name-only | grep -v '^bun.lock$'; git ls-files --others --exclude-standard
        git ls-tree -r --name-only HEAD | while read -r file; do [ -L "$file" ] && echo "$file"; done; } | sort -u) > "$overlay/overlay-files.txt"
      tar -ch --exclude=node_modules -C "$here/opencode" -T "$overlay/overlay-files.txt" -f - | xz -9 > "$overlay/overlay.tar.xz"
      ssh -o BatchMode=yes "$host" "if not exist \"$root\\oc2\\harness\" mkdir \"$root\\oc2\\harness\""
      cp_to "$here/installed-windows.ps1" "$overlay/overlay.tar.xz" "$overlay/overlay-files.txt" "$host:$remote/"
      cp_to "$here/harness/installed.ts" "$here/harness/env.ts" "$here/harness/mock-llm.ts" "$here/harness/electron-builder.spike.ts" \
        "$host:$remote/oc2/harness/" ;;
    setup | build | run | clean) ps "$step" ;;
    fetch)
      mkdir -p "$run/windows/stand"
      out=$remote/oc2/.run/b0-installed/windows/run
      for src in "$remote/logs" "$out/report.json" "$out/shots" "$out/plugin.jsonl" "$out/llm.jsonl" "$out/sse.jsonl" \
        "$out/app-first.log" "$out/app-second.log"; do
        cp_to -r "$host:$src" "$run/windows/stand/" || true
      done
      rm -rf "$run/windows/stand/desktop-logs"
      cp_to -r "$host:$out/root/desktop/logs" "$run/windows/stand/desktop-logs" || true ;;
    *) echo "unknown step $step" >&2; exit 2 ;;
  esac
done
