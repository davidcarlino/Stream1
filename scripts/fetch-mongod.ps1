#requires -Version 5.1
<#
.SYNOPSIS
  Downloads a local MongoDB (mongod) binary into vendor/mongodb so STREAM1 can
  run its database fully offline, with no cloud/Atlas and no separate install.

.DESCRIPTION
  Fetches the official MongoDB Community Server ZIP for Windows, extracts just
  the files needed to run mongod (mongod.exe + required DLLs), and places them
  in vendor/mongodb/bin. The STREAM1 server executable looks here first.

  Run once on a machine with internet access; after that the app is offline.

.EXAMPLE
  ./scripts/fetch-mongod.ps1

.EXAMPLE
  ./scripts/fetch-mongod.ps1 -Version 7.0.14
#>

[CmdletBinding()]
param(
  [string]$Version = "7.0.14"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$vendor    = Join-Path $repoRoot "vendor\mongodb"
$binDir    = Join-Path $vendor "bin"

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  $m" -ForegroundColor Green }

Write-Host "`n=== Fetch local MongoDB (mongod) ===`n" -ForegroundColor White

if (Test-Path (Join-Path $binDir "mongod.exe")) {
  Ok "mongod.exe already present at vendor\mongodb\bin - nothing to do."
  Write-Host ""
  exit 0
}

$zipName = "mongodb-windows-x86_64-$Version.zip"
$url     = "https://fastdl.mongodb.org/windows/$zipName"
$tmp     = Join-Path $env:TEMP "stream1-mongo"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$zipPath = Join-Path $tmp $zipName

Info "Downloading $url"
Info "(this is a few hundred MB - one time only)"
try {
  Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
} catch {
  Write-Host "  Download failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  Check the version number, or download manually from https://www.mongodb.com/try/download/community" -ForegroundColor Yellow
  exit 1
}
Ok "Downloaded."

Info "Extracting..."
$extractDir = Join-Path $tmp "extract"
if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force

# The zip contains a top-level folder like mongodb-win32-x86_64-windows-7.0.14\bin
$srcBin = Get-ChildItem -Path $extractDir -Recurse -Directory | Where-Object { $_.Name -eq "bin" } | Select-Object -First 1
if (-not $srcBin) { Write-Host "  Could not locate bin\ in the archive." -ForegroundColor Red; exit 1 }

New-Item -ItemType Directory -Force -Path $binDir | Out-Null

# We only need mongod plus any DLLs that ship alongside it.
Get-ChildItem -Path $srcBin.FullName -File | Where-Object { $_.Name -like "mongod*.exe" -or $_.Extension -eq ".dll" } | ForEach-Object {
  Copy-Item $_.FullName -Destination $binDir -Force
}

if (-not (Test-Path (Join-Path $binDir "mongod.exe"))) {
  Write-Host "  mongod.exe was not found after extraction." -ForegroundColor Red
  exit 1
}

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Ok "mongod is ready at: $binDir"
Write-Host "`nSTREAM1 will use this automatically." -ForegroundColor White
Write-Host ""
