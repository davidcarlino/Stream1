#requires -Version 5.1
<#
.SYNOPSIS
  Downloads yt-dlp for offline stream recording downloads on Windows.

.EXAMPLE
  ./scripts/fetch-yt-dlp.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot  = Split-Path -Parent $scriptDir
$vendor    = Join-Path $repoRoot "vendor\yt-dlp"
$exePath   = Join-Path $vendor "yt-dlp.exe"

function Info($m) { Write-Host "  $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  $m" -ForegroundColor Green }

Write-Host "`n=== Fetch yt-dlp (stream recording downloads) ===`n" -ForegroundColor White

if (Test-Path $exePath) {
  Ok "yt-dlp.exe already present at vendor\yt-dlp - nothing to do."
  Write-Host ""
  exit 0
}

New-Item -ItemType Directory -Force -Path $vendor | Out-Null
$tmp = Join-Path $env:TEMP ("stream1-ytdlp-" + [guid]::NewGuid().ToString())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

try {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest" -Headers @{ "User-Agent" = "STREAM1" }
  $asset = $release.assets | Where-Object { $_.name -eq "yt-dlp.exe" } | Select-Object -First 1
  if (-not $asset) { throw "Could not find yt-dlp.exe in the latest GitHub release." }

  Info "Downloading $($asset.name)…"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $exePath -UseBasicParsing
  Ok "Saved: vendor\yt-dlp\yt-dlp.exe"
  Write-Host ""
  Write-Host "Past stream downloads in STREAM1 will use this tool." -ForegroundColor DarkGray
  Write-Host ""
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
