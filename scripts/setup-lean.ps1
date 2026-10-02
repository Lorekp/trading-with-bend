$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$taskPin = Get-Content -LiteralPath 'toolchain.json' -Raw | ConvertFrom-Json
$taskArchive = ".tools/lean-$($taskPin.leanVersion)-linux.tar.zst"
$taskDirectory = ".tools/lean-$($taskPin.leanVersion)-linux"
New-Item -ItemType Directory -Force -Path '.tools' | Out-Null
if (-not (Test-Path -LiteralPath "$taskDirectory/bin/lean")) {
  Invoke-WebRequest -Uri "https://github.com/leanprover/lean4/releases/download/v$($taskPin.leanVersion)/lean-$($taskPin.leanVersion)-linux.tar.zst" -OutFile $taskArchive
  $taskHash = (Get-FileHash -LiteralPath $taskArchive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($taskHash -ne $taskPin.leanLinuxX64ArchiveSha256) { throw 'Lean archive checksum mismatch' }
  tar -xf $taskArchive -C .tools
  if ($LASTEXITCODE -ne 0) { throw 'Lean extraction failed' }
}
$taskDistribution = if ($env:BEND_WSL_DISTRO) { $env:BEND_WSL_DISTRO } else { 'Ubuntu-24.04' }
wsl -d $taskDistribution -- bash -c 'chmod +x .tools/lean-4.34.0-linux/bin/* && bash scripts/build-kernel.sh'
if ($LASTEXITCODE -ne 0) { throw 'Kernel compilation failed' }
node scripts/build.mjs --verdict
if ($LASTEXITCODE -ne 0) { throw 'Bend kernel verification failed' }
