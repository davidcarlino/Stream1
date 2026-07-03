#requires -Version 5.1
<#
.SYNOPSIS
  Downloads ffmpeg for the Facebook simulcast relay (YouTube feed -> Facebook RTMPS).

.EXAMPLE
  ./scripts/fetch-ffmpeg.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$vendor    = Join-Path $repoRoot "vendor\ffmpeg"
$exePath   = Join-Path $vendor "ffmpeg.exe"

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  $m" -ForegroundColor Green }

Write-Host "`n=== Fetch ffmpeg (Facebook simulcast relay) ===`n" -ForegroundColor White

if (Test-Path $exePath) {
  Ok "ffmpeg.exe already present at vendor\ffmpeg - nothing to do."
  Write-Host ""
  exit 0
}

New-Item -ItemType Directory -Force -Path $vendor | Out-Null
$tmp = Join-Path $env:TEMP ("stream1-ffmpeg-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  # gyan.dev hosts the official Windows essentials builds linked from ffmpeg.org.
  $zipUrl  = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip"
  $zipPath = Join-Path $tmp "ffmpeg.zip"

  Info "Downloading ffmpeg-release-essentials.zip (~90 MB)…"
  Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

  Info "Extracting…"
  Expand-Archive -Path $zipPath -DestinationPath $tmp -Force

  $found = Get-ChildItem -Path $tmp -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
  if (-not $found) { throw "ffmpeg.exe was not found inside the downloaded archive." }

  Copy-Item $found.FullName $exePath -Force
  Ok "Saved: vendor\ffmpeg\ffmpeg.exe"
  Write-Host ""
  Write-Host "Facebook simulcasting in STREAM1 will use this tool." -ForegroundColor DarkGray
  Write-Host ""
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
