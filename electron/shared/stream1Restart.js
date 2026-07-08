'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { installDir, resolveServerExe, resolveAppExe } = require('./paths');
const { appPort, readLauncherConfig } = require('./serverClient');
const { spawnHidden } = require('./winProcess');

function escapePs(value) {
  return String(value == null ? '' : value).replace(/'/g, "''");
}

function imageName(exePath, fallback) {
  return exePath ? path.basename(exePath) : fallback;
}

function buildRestartScript({ installPath, serverExe, appExe, port, noPrompt }) {
  const serverImage = imageName(serverExe, 'STREAM1 Server.exe');
  const appImage = imageName(appExe, 'STREAM1 App.exe');
  const noPromptFlag = noPrompt ? '1' : '0';

  return `# STREAM1 full restart (server then app)
$ErrorActionPreference = 'SilentlyContinue'
$InstallDir = '${escapePs(installPath)}'
$ServerExe = '${escapePs(serverExe)}'
$AppExe = '${escapePs(appExe)}'
$ServerImage = '${escapePs(serverImage)}'
$AppImage = '${escapePs(appImage)}'
$Port = ${Number(port) || 15000}
$NoPrompt = '${noPromptFlag}'
$Taskkill = Join-Path $env:WINDIR 'System32\\taskkill.exe'

function Test-ImageRunning {
  param([string]$Image)
  $out = & $Taskkill /FI "IMAGENAME eq $Image" /FO CSV /NH 2>$null
  return [bool]($out -match [regex]::Escape($Image))
}

function Stop-Stream1Processes {
  for ($i = 0; $i -lt 10; $i++) {
    & $Taskkill /IM $AppImage /F /T 2>$null | Out-Null
    & $Taskkill /IM $ServerImage /F /T 2>$null | Out-Null
    if (-not (Test-ImageRunning -Image $AppImage) -and -not (Test-ImageRunning -Image $ServerImage)) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
}

function Test-ServerPing {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/ping" -UseBasicParsing -TimeoutSec 2
    return ($r.StatusCode -eq 200)
  } catch {
    return $false
  }
}

function Wait-ServerReady {
  param([int]$TimeoutSec = 120)
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Test-ServerPing) { return $true }
    Start-Sleep -Milliseconds 700
  }
  return $false
}

Stop-Stream1Processes
Start-Sleep -Seconds 2

if (-not (Test-Path -LiteralPath $ServerExe)) { exit 1 }

$env:STREAM1_ROOT = $InstallDir
$env:STREAM1_INSTALL_DIR = $InstallDir
if ($NoPrompt -eq '1') { $env:STREAM1_NO_PROMPT = '1' } else { Remove-Item Env:STREAM1_NO_PROMPT -ErrorAction SilentlyContinue }

Start-Process -FilePath $ServerExe -WorkingDirectory $InstallDir -WindowStyle Normal
if (-not (Wait-ServerReady)) { exit 2 }

if (-not (Test-Path -LiteralPath $AppExe)) { exit 3 }
Start-Process -FilePath $AppExe -WorkingDirectory $InstallDir -WindowStyle Normal
exit 0
`;
}

function launchFullStream1Restart() {
  if (process.platform !== 'win32') {
    return { ok: false, error: 'Full restart is only supported on Windows.' };
  }

  const installPath = installDir();
  const serverExe = resolveServerExe();
  const appExe = resolveAppExe();

  if (!serverExe) {
    return {
      ok: false,
      error: `Could not find STREAM1 Server.exe in ${installPath}.`,
    };
  }
  if (!appExe) {
    return {
      ok: false,
      error: `Could not find STREAM1 App.exe in ${installPath}.`,
    };
  }

  const cfg = readLauncherConfig();
  const hasRemembered = Boolean(cfg && cfg.dataDir && fs.existsSync(cfg.dataDir));
  const scriptDir = path.join(os.tmpdir(), 'stream1-restart');
  fs.mkdirSync(scriptDir, { recursive: true });
  const scriptPath = path.join(scriptDir, 'stream1-full-restart.ps1');
  fs.writeFileSync(
    scriptPath,
    buildRestartScript({
      installPath,
      serverExe,
      appExe,
      port: appPort(),
      noPrompt: hasRemembered,
    }),
    'utf8'
  );

  const psExe = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );

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
      scriptPath,
    ],
    { detached: true, stdio: 'ignore' }
  );

  if (!child.pid) {
    return { ok: false, error: 'Could not start the restart helper.' };
  }
  child.unref();
  return { ok: true };
}

module.exports = { launchFullStream1Restart };
