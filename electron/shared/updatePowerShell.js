'use strict';

const fs = require('fs');
const path = require('path');
const { spawnHidden } = require('./winProcess');
const { loadMeta } = require('./updateApply');
const { isWindowsAdmin } = require('./winAdmin');

function escapePs(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

function buildInstallScript({ metaPath, parentPid, logPath, progressPath }) {
  const meta = loadMeta(metaPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = path.join(meta.installDir, '.stream1-backup', `${meta.version}-${stamp}`);

  return `# STREAM1 elevated update installer (external process — not Server.exe)
$ErrorActionPreference = 'Stop'
$MetaPath = '${escapePs(metaPath)}'
$ParentPid = ${Number(parentPid) || 0}
$LogPath = '${escapePs(logPath)}'
$ProgressPath = '${escapePs(progressPath)}'
$meta = Get-Content -LiteralPath $MetaPath -Raw | ConvertFrom-Json
$installDir = $meta.installDir
$backupDir = '${escapePs(backupRoot)}'
$serverImage = 'STREAM1 Server.exe'
$appImage = 'STREAM1 App.exe'
$taskkill = Join-Path $env:WINDIR 'System32\\taskkill.exe'
$tasklist = Join-Path $env:WINDIR 'System32\\tasklist.exe'

function Write-Log {
  param([string]$Message)
  $line = "[$(Get-Date -Format o)] $Message"
  Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
}

function Write-Progress {
  param([int]$Percent, [string]$Label, [string]$Phase = 'install')
  @{ phase = $Phase; percent = $Percent; label = $Label; at = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $ProgressPath -Encoding UTF8
}

function Resolve-ExeNames {
  param([string]$Dir)
  $names = Get-ChildItem -LiteralPath $Dir -Filter '*.exe' -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }
  foreach ($n in $names) {
    if ($n -match 'stream1' -and $n -match 'server') { $script:serverImage = $n }
    if ($n -match 'stream1' -and $n -match 'app' -and $n -notmatch 'server') { $script:appImage = $n }
  }
}

function Test-ImageRunning {
  param([string]$Image)
  $running = & $tasklist /FI "IMAGENAME eq $Image" /FO CSV /NH 2>$null
  return [bool]($running -match [regex]::Escape($Image))
}

function Stop-Image {
  param([string]$Image)
  & $taskkill /IM $Image /F /T 2>$null | Out-Null
}

function Test-TargetPidRunning {
  param([int]$TargetPid)
  if ($TargetPid -le 0) { return $false }
  try {
    $null = Get-Process -Id $TargetPid -ErrorAction Stop
    return $true
  } catch {
    return $false
  }
}

function Force-StopStream1 {
  Resolve-ExeNames -Dir $installDir
  Write-Log "Stopping $appImage and $serverImage (parent PID $ParentPid)"
  Write-Progress -Percent 10 -Label 'Closing STREAM1 App and Server…'
  for ($attempt = 0; $attempt -lt 24; $attempt++) {
    Stop-Image -Image $appImage
    Stop-Image -Image $serverImage
    if ($ParentPid -gt 0) {
      Stop-Process -Id $ParentPid -Force -ErrorAction SilentlyContinue
    }
    $appRunning = Test-ImageRunning -Image $appImage
    $serverRunning = Test-ImageRunning -Image $serverImage
    $parentRunning = Test-TargetPidRunning -TargetPid $ParentPid
    if (-not $appRunning -and -not $serverRunning -and -not $parentRunning) {
      Write-Log 'All STREAM1 processes stopped.'
      return
    }
    Start-Sleep -Milliseconds 500
  }
  throw 'Could not close STREAM1 App and Server. Close them manually and try again.'
}

function Copy-UpdateFile {
  param([string]$Source, [string]$Dest, [string]$Name)
  Write-Log "Copying $Name"
  Write-Progress -Percent 40 -Label "Installing $Name…"
  if (Test-Path -LiteralPath $Dest) {
    Remove-Item -LiteralPath $Dest -Force -ErrorAction Stop
  }
  Copy-Item -LiteralPath $Source -Destination $Dest -Force -ErrorAction Stop
}

function Restore-Backup {
  Write-Log 'Rolling back from backup'
  if (-not (Test-Path -LiteralPath $backupDir)) { return }
  $backupMetaPath = Join-Path $backupDir 'backup-meta.json'
  if (-not (Test-Path -LiteralPath $backupMetaPath)) { return }
  $backupMeta = Get-Content -LiteralPath $backupMetaPath -Raw | ConvertFrom-Json
  foreach ($name in $backupMeta.files) {
    $src = Join-Path $backupDir $name
    if (Test-Path -LiteralPath $src) {
      Copy-Item -LiteralPath $src -Destination (Join-Path $installDir $name) -Force
    }
  }
}

try {
  Write-Log "Update install started. installDir=$installDir"
  Write-Progress -Percent 5 -Label 'Preparing to install…'

  Force-StopStream1
  Start-Sleep -Seconds 2

  New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
  Write-Progress -Percent 25 -Label 'Backing up current version…'
  $backed = @()
  foreach ($prop in $meta.files.PSObject.Properties) {
    $entry = $prop.Value
    if (-not $entry.name -or -not $entry.source) { continue }
    $installed = Join-Path $installDir $entry.name
    if (Test-Path -LiteralPath $installed) {
      Copy-Item -LiteralPath $installed -Destination (Join-Path $backupDir $entry.name) -Force
      $backed += $entry.name
    }
  }
  @{ installDir = $installDir; version = $meta.version; files = $backed; createdAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $backupDir 'backup-meta.json') -Encoding UTF8

  $fileCount = @($meta.files.PSObject.Properties | Where-Object { $_.Value.name -and $_.Value.source }).Count
  $done = 0
  foreach ($prop in $meta.files.PSObject.Properties) {
    $entry = $prop.Value
    if (-not $entry.name -or -not $entry.source) { continue }
    if (-not (Test-Path -LiteralPath $entry.source)) {
      throw "Downloaded file missing: $($entry.source)"
    }
    $dest = Join-Path $installDir $entry.name
    $pct = 30 + [int](($done / [Math]::Max(1, $fileCount)) * 60)
    Write-Progress -Percent $pct -Label "Installing $($entry.name)…"
    Copy-UpdateFile -Source $entry.source -Dest $dest -Name $entry.name
    $done++
  }

  Resolve-ExeNames -Dir $installDir
  $serverExe = Join-Path $installDir $serverImage
  if (-not (Test-Path -LiteralPath $serverExe)) {
    throw "$serverImage was not found in $installDir after copy."
  }

  Write-Progress -Percent 95 -Label 'Starting STREAM1 Server…'
  Write-Log "Starting $serverExe"
  Start-Process -FilePath $serverExe -WorkingDirectory $installDir -WindowStyle Normal
  Write-Progress -Percent 100 -Label 'Update complete' -Phase 'done'
  Write-Log 'Update install completed successfully.'
  exit 0
} catch {
  Write-Log "Update install FAILED: $($_.Exception.Message)"
  Write-Progress -Percent 0 -Label 'Update failed' -Phase 'error'
  try { Restore-Backup } catch { Write-Log "Rollback failed: $($_.Exception.Message)" }
  try {
    Resolve-ExeNames -Dir $installDir
    $serverExe = Join-Path $installDir $serverImage
    if (Test-Path -LiteralPath $serverExe) {
      Start-Process -FilePath $serverExe -WorkingDirectory $installDir -WindowStyle Normal
    }
  } catch { Write-Log "Could not restart server after failure: $($_.Exception.Message)" }
  exit 1
}
`;
}

function buildUacLauncherScript({ installScriptPath, readyFlagPath }) {
  return `# STREAM1 UAC launcher
$ErrorActionPreference = 'Stop'
$ReadyFlag = '${escapePs(readyFlagPath)}'
$InstallScript = '${escapePs(installScriptPath)}'
$psExe = Join-Path $env:WINDIR 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'

Remove-Item -LiteralPath $ReadyFlag -Force -ErrorAction SilentlyContinue

try {
  $argList = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-Command',
    "Set-Content -LiteralPath '$ReadyFlag' '1' -Encoding ASCII; & '$InstallScript'"
  )
  Start-Process -FilePath $psExe -Verb RunAs -ArgumentList $argList -WindowStyle Hidden | Out-Null
} catch {
  exit 1
}

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
  if (Test-Path -LiteralPath $ReadyFlag) { exit 0 }
  Start-Sleep -Milliseconds 250
}
exit 2
`;
}

function psExePath() {
  return path.join(
    process.env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
}

function spawnInstallScript(installScriptPath, readyFlagPath, { waitForReady = false } = {}) {
  const psExe = psExePath();

  if (waitForReady) {
    return new Promise((resolve) => {
      const child = spawnHidden(
        psExe,
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Set-Content -LiteralPath '${escapePs(readyFlagPath)}' '1' -Encoding ASCII; & '${escapePs(installScriptPath)}'`,
        ],
        { detached: false, stdio: 'ignore' }
      );

      child.on('error', () => resolve({ ok: false, error: 'Could not start the update installer.' }));
      child.on('exit', (code) => {
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, error: `Update installer exited with code ${code}.` });
      });
    });
  }

  const child = spawnHidden(
    psExe,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-WindowStyle',
      'Hidden',
      '-File',
      installScriptPath,
    ],
    { detached: true, stdio: 'ignore' }
  );
  child.unref();
  return Promise.resolve({ ok: Boolean(child.pid) });
}

function launchUacInstaller(launcherScriptPath, readyFlagPath) {
  return new Promise((resolve) => {
    const child = spawnHidden(
      psExePath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        launcherScriptPath,
      ],
      { detached: false, stdio: 'ignore' }
    );

    child.on('error', () => {
      resolve({ ok: false, error: 'Could not start the update installer.' });
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      if (code === 2) {
        resolve({
          ok: false,
          error:
            'Administrator permission is required to update STREAM1. Click Yes on the Windows security prompt, then try again.',
        });
        return;
      }
      resolve({
        ok: false,
        error:
          'Could not start the elevated update installer. Administrator permission may have been denied.',
      });
    });
  });
}

/**
 * Install via external PowerShell (never Server.exe — avoids self-kill and exe file locks).
 */
function launchElevatedPowerShellInstall(metaPath, parentPid) {
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, error: 'Updates are only supported on Windows.' });
  }

  const scriptDir = path.join(path.dirname(metaPath), 'runner');
  fs.mkdirSync(scriptDir, { recursive: true });
  const installScriptPath = path.join(scriptDir, 'stream1-install.ps1');
  const launcherScriptPath = path.join(scriptDir, 'stream1-install-uac.ps1');
  const readyFlagPath = path.join(scriptDir, 'install-accepted.flag');
  const logPath = path.join(scriptDir, 'install.log');
  const progressPath = path.join(scriptDir, 'install-progress.json');

  fs.writeFileSync(
    installScriptPath,
    buildInstallScript({ metaPath, parentPid, logPath, progressPath }),
    'utf8'
  );
  fs.writeFileSync(launcherScriptPath, buildUacLauncherScript({ installScriptPath, readyFlagPath }), 'utf8');

  try {
    fs.unlinkSync(readyFlagPath);
  } catch {
    /* ignore */
  }
  try {
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] Update installer prepared.\n`, 'utf8');
  } catch {
    /* ignore */
  }

  // Already admin (Server runs elevated) — run install script directly, no second UAC prompt.
  if (isWindowsAdmin()) {
    return spawnInstallScript(installScriptPath, readyFlagPath, { waitForReady: false }).then((result) => {
      if (result.ok) {
        try {
          fs.writeFileSync(readyFlagPath, '1', 'ascii');
        } catch {
          /* ignore */
        }
      }
      return result;
    });
  }

  return launchUacInstaller(launcherScriptPath, readyFlagPath);
}

module.exports = { launchElevatedPowerShellInstall };
