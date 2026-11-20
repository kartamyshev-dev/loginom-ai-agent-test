#!/bin/sh
# B0.4b from Linux: after `build-installed.sh windows`, copies the unpacked app, the NSIS kit and the harness to the stand,
# builds the installer there (installed-windows.ps1 -Action nsis), runs the installed check and fetches the evidence into
# .run/b0-installed/windows/stand/. Usage: installed-windows.sh <ssh-alias> [copy|setup|nsis|run|fetch|clean]...
# Without steps it runs copy setup nsis run fetch. `clean` removes C:\lab\b0-installed from the stand.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
host=$1
shift
root='C:\lab\b0-installed'
remote=$(printf '%s' "$root" | tr '\\' /)
run=$here/.run/b0-installed
ps() { ssh -o BatchMode=yes -o ServerAliveInterval=30 "$host" "powershell -NoProfile -ExecutionPolicy Bypass -File \"$root\\installed-windows.ps1\" -Root \"$root\" -Action $1"; }
[ $# -gt 0 ] || set -- copy setup nsis run fetch
for step in "$@"; do
  case $step in
    copy)
      ssh -o BatchMode=yes "$host" "if not exist \"$root\\oc2\\harness\" mkdir \"$root\\oc2\\harness\""
      scp -o BatchMode=yes -q "$here/installed-windows.ps1" "$run/win-unpacked.tgz" "$host:$remote/"
      scp -o BatchMode=yes -q -r "$run/nsis-kit" "$host:$remote/"
      scp -o BatchMode=yes -q "$here/harness/installed.ts" "$here/harness/env.ts" "$here/harness/mock-llm.ts" "$host:$remote/oc2/harness/" ;;
    setup | nsis | run | clean) ps "$step" ;;
    fetch)
      mkdir -p "$run/windows/stand"
      out=$remote/oc2/.run/b0-installed/windows/run
      for item in logs "$out/report.json" "$out/shots" "$out/plugin.jsonl" "$out/llm.jsonl" "$out/sse.jsonl" \
        "$out/app-first.log" "$out/app-second.log" "$out/root/desktop/logs"; do
        case $item in /*|C:*) src=$item ;; *) src=$remote/$item ;; esac
        scp -o BatchMode=yes -q -r "$host:$src" "$run/windows/stand/" || true
      done
      scp -o BatchMode=yes -q "$host:$remote/nsis-kit/dist/*.exe" "$run/dist-windows/" || true ;;
    *) echo "unknown step $step" >&2; exit 2 ;;
  esac
done
