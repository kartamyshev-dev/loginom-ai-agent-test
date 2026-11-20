#!/bin/sh
# Prepares the spike sandbox on a Windows stand over SSH. The stand needs no git: the tag's source with patches/*.patch
# and the loginom-product plugin is packed here into oc2.tar, then setup-windows.ps1 unpacks it under <root>, fetches a
# portable Bun and installs dependencies. Usage: setup-windows.sh <ssh-alias> [tag] [root]
# Defaults: v2.3.0, C:\lab\b0-windows. Checks: ssh <alias> powershell -File <root>\setup-windows.ps1 -Action run -Check s5
set -eu
here=$(cd "$(dirname "$0")" && pwd)
host=$1
tag=${2:-v2.3.0}
root=${3:-'C:\lab\b0-windows'}
repo=$(git -C "$here" rev-parse --show-toplevel)
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/oc2/opencode"
git -C "$repo" archive "$tag" | tar -x -C "$stage/oc2/opencode"
# Outside any repository git apply patches the extracted files and stops on the first conflict.
for patch in "$here"/patches/*.patch; do (cd "$stage/oc2/opencode" && git apply "$patch"); done
grep -q LOGINOM_SPIKE_U5_IDENTITY "$stage/oc2/opencode/packages/cli/src/services/service-config.ts"
test -f "$stage/oc2/opencode/packages/core/src/plugin/product.ts"
# A copy instead of the POSIX symlink: imports resolve from opencode/node_modules without links on the stand.
cp -R "$here/plugin/loginom-product" "$stage/oc2/opencode/packages/core/src/plugin/loginom-product"
cp -R "$here/harness" "$here/plugin" "$stage/oc2/"
# -h turns the tag's few symlinks (web app icons) into plain files.
tar -ch -C "$stage" -f "$stage/oc2.tar" oc2
ssh -o BatchMode=yes "$host" "if not exist \"$root\" mkdir \"$root\""
scp -o BatchMode=yes -q "$stage/oc2.tar" "$here/setup-windows.ps1" "$host:$(printf '%s' "$root" | tr '\\' /)/"
# Keepalives: bun install prints nothing for minutes, and an idle connection through a jump host gets closed.
ssh -o BatchMode=yes -o ServerAliveInterval=30 "$host" "powershell -NoProfile -ExecutionPolicy Bypass -File \"$root\\setup-windows.ps1\" -Root \"$root\" -Action setup"
