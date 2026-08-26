[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [Parameter(Mandatory = $true)][string]$ArchivePath,
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$ExecutablePath
)

$ErrorActionPreference = 'Stop'
$installRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$archivePath = [System.IO.Path]::GetFullPath($ArchivePath)
$stageRoot = Join-Path $env:TEMP ("listagent-update-" + [guid]::NewGuid().ToString('N'))

try {
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not (Test-Path -LiteralPath $archivePath)) { throw 'Update archive not found.' }
  New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
  Expand-Archive -LiteralPath $archivePath -DestinationPath $stageRoot -Force
  $payload = Get-ChildItem -LiteralPath $stageRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } | Select-Object -First 1
  if (-not $payload) { $payload = Get-Item -LiteralPath $stageRoot }
  foreach ($item in Get-ChildItem -LiteralPath $payload.FullName -Force) {
    if ($item.Name -in @('data', '.runtime')) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $installRoot $item.Name) -Recurse -Force
  }
  Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
  Start-Process -FilePath $ExecutablePath -WorkingDirectory $installRoot -ArgumentList @('"' + $installRoot + '."')
} finally {
  Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue
}
