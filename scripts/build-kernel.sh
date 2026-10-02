#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source_file=.tools/bend/bend2/bendtt.lean
kernel=.tools/bendtt/bendtt
stamp=.tools/bendtt/checksums
lean_bin="$PWD/.tools/lean-4.34.0-linux/bin"
if [ ! -x "$lean_bin/lean" ]; then
  echo 'Missing project-local Lean 4.34.0. Run scripts/setup-lean.ps1 on Windows, or download the pinned Linux archive from toolchain.json.' >&2
  exit 1
fi
if [ -f "$stamp" ] && sha256sum --status -c "$stamp"; then
  exit 0
fi
mkdir -p .tools/bendtt
"$lean_bin/lean" -c .tools/bendtt/bendtt.c "$source_file"
"$lean_bin/leanc" -O3 -DNDEBUG .tools/bendtt/bendtt.c -o "$kernel"
sha256sum "$source_file" "$kernel" > "$stamp"
