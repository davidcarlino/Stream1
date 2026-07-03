# Creates a local code-signing certificate for STREAM1 Windows builds.
# Self-signed = fine for in-house installs; SmartScreen will still warn until you use a commercial cert.
#
# Output: certs/stream1-codesign.pfx  (password: stream1-dev unless STREAM1_SIGN_PASSWORD is set)
# Publisher: David Carlino  |  Brand: STREAM1

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$certDir = Join-Path $root 'certs'
$passwordPlain = $env:STREAM1_SIGN_PASSWORD
if (-not $passwordPlain) { $passwordPlain = 'stream1-dev' }

New-Item -ItemType Directory -Force -Path $certDir | Out-Null
$pfxPath = Join-Path $certDir 'stream1-codesign.pfx'
$pwd = ConvertTo-SecureString -String $passwordPlain -Force -AsPlainText

if (Test-Path $pfxPath) {
  Write-Host "Removing existing certificate: $pfxPath"
  Remove-Item -Force $pfxPath
}

Write-Host ""
Write-Host "Creating STREAM1 code-signing certificate..."
Write-Host "  Developer: David Carlino"
Write-Host "  Brand:     STREAM1"
Write-Host ""

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject "CN=David Carlino, O=STREAM1, OU=STREAM1, C=AU" `
  -FriendlyName "STREAM1 Code Signing (David Carlino)" `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable `
  -CertStoreLocation Cert:\CurrentUser\My `
  -NotAfter (Get-Date).AddYears(5)

Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $pwd | Out-Null

Write-Host "Saved:     $pfxPath"
Write-Host "Password:  $passwordPlain"
Write-Host ""
Write-Host "Next: npm run build   (or npm run all)"
Write-Host "To trust on this PC (optional, admin PowerShell):"
Write-Host "  Import-PfxCertificate -FilePath '$pfxPath' -CertStoreLocation Cert:\LocalMachine\Root"
Write-Host ""
