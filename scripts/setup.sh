#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
revision=$(node -p "JSON.parse(require('fs').readFileSync('toolchain.json')).bendRevision")
bun_version=$(node -p "JSON.parse(require('fs').readFileSync('toolchain.json')).bunVersion")
bun_hash=$(node -p "JSON.parse(require('fs').readFileSync('toolchain.json')).bunLinuxX64ZipSha256")
mkdir -p .tools
if [ ! -d .tools/bend ]; then
  git clone --no-checkout https://github.com/bendlang/bend.git .tools/bend
  git -C .tools/bend checkout --detach "$revision"
fi
test "$(git -C .tools/bend rev-parse HEAD)" = "$revision"
if [ ! -f .tools/bun-linux-x64/bun ]; then
  test "$(uname -sm)" = 'Linux x86_64' || { echo 'Install Bun for your platform and follow README.md.'; exit 1; }
  curl -fL "https://github.com/oven-sh/bun/releases/download/bun-v${bun_version}/bun-linux-x64.zip" -o .tools/bun-linux.zip
  echo "$bun_hash  .tools/bun-linux.zip" | sha256sum -c -
  unzip .tools/bun-linux.zip -d .tools
fi
chmod +x .tools/bun-linux-x64/bun
node scripts/build.mjs
