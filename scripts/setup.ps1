$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
npm ci
if ($LASTEXITCODE -ne 0) { throw 'Locked dependency installation failed' }
$taskPin = Get-Content -LiteralPath 'toolchain.json' -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path '.tools' | Out-Null
if (-not (Test-Path -LiteralPath '.tools/bend')) {
  git clone --no-checkout $taskPin.bendRepository .tools/bend
  if ($LASTEXITCODE -ne 0) { throw 'Compiler download failed' }
  git -C .tools/bend checkout --detach $taskPin.bendRevision
  if ($LASTEXITCODE -ne 0) { throw 'Pinned checkout failed' }
}
$taskRevision = git -C .tools/bend rev-parse HEAD
if ($taskRevision -ne $taskPin.bendRevision) { throw 'Existing compiler has a different revision; preserve it and resolve manually' }
if (-not (Test-Path -LiteralPath '.tools/bun-linux-x64/bun')) {
  $taskUrl = "https://github.com/oven-sh/bun/releases/download/bun-v$($taskPin.bunVersion)/bun-linux-x64.zip"
  Invoke-WebRequest -Uri $taskUrl -OutFile '.tools/bun-linux.zip'
  $taskHash = (Get-FileHash -LiteralPath '.tools/bun-linux.zip' -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($taskHash -ne $taskPin.bunLinuxX64ZipSha256) { throw 'Bun archive checksum mismatch' }
  Expand-Archive -LiteralPath '.tools/bun-linux.zip' -DestinationPath '.tools'
}
$taskDistribution = if ($env:BEND_WSL_DISTRO) { $env:BEND_WSL_DISTRO } else { 'Ubuntu-24.04' }
wsl -d $taskDistribution -- chmod +x .tools/bun-linux-x64/bun
if ($LASTEXITCODE -ne 0) { throw "WSL distribution '$taskDistribution' is required. Set BEND_WSL_DISTRO to use another installed distribution. See README.md." }
node scripts/build.mjs
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
