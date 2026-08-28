[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$ArchivePath = '',
  [string]$PayloadPath = '',
  [Parameter(Mandatory = $true)][int]$ParentPid,
  [Parameter(Mandatory = $true)][string]$ExecutablePath
)

$ErrorActionPreference = 'Stop'
$installRoot = [System.IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
$updatesRoot = [System.IO.Path]::GetFullPath((Join-Path $installRoot '.runtime\updates')).TrimEnd('\')
$stageRoot = $null
$sourceRoot = $null
$payloadToRemove = $null

function Test-UnderDirectory([string]$Path, [string]$Root) {
  $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $fullRoot = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  return $fullPath.StartsWith($fullRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

try {
  if ([string]::IsNullOrWhiteSpace($ArchivePath) -eq ([string]::IsNullOrWhiteSpace($PayloadPath))) {
    throw 'Exactly one update payload must be provided.'
  }
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not [string]::IsNullOrWhiteSpace($PayloadPath)) {
    $payloadToRemove = [System.IO.Path]::GetFullPath($PayloadPath)
    if (-not (Test-UnderDirectory $payloadToRemove $updatesRoot)) { throw 'Update payload is outside the application update directory.' }
    if (-not (Test-Path -LiteralPath $payloadToRemove -PathType Container)) { throw 'Update payload not found.' }
    $sourceRoot = $payloadToRemove
  } else {
    $archivePath = [System.IO.Path]::GetFullPath($ArchivePath)
    if (-not (Test-UnderDirectory $archivePath $updatesRoot)) { throw 'Update archive is outside the application update directory.' }
    if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw 'Update archive not found.' }
    $stageRoot = Join-Path $env:TEMP ("listagent-update-" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    Expand-Archive -LiteralPath $archivePath -DestinationPath $stageRoot -Force
    $payload = Get-ChildItem -LiteralPath $stageRoot -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } | Select-Object -First 1
    if (-not $payload) { $payload = Get-Item -LiteralPath $stageRoot }
    $sourceRoot = $payload.FullName
  }
  foreach ($item in Get-ChildItem -LiteralPath $sourceRoot -Force) {
    if ($item.Name -in @('data', '.runtime')) { continue }
    if ($item.Name -eq 'node_modules' -and $payloadToRemove) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $installRoot $item.Name) -Recurse -Force
  }
  if ($ArchivePath) { Remove-Item -LiteralPath ([System.IO.Path]::GetFullPath($ArchivePath)) -Force -ErrorAction SilentlyContinue }
  if ($payloadToRemove) { Remove-Item -LiteralPath $payloadToRemove -Recurse -Force -ErrorAction SilentlyContinue }
  Start-Process -FilePath $ExecutablePath -WorkingDirectory $installRoot -ArgumentList @('"' + $installRoot + '"')
} finally {
  if ($stageRoot) { Remove-Item -LiteralPath $stageRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if ($payloadToRemove -and (Test-Path -LiteralPath $payloadToRemove)) { Remove-Item -LiteralPath $payloadToRemove -Recurse -Force -ErrorAction SilentlyContinue }
}
