[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$stage = Join-Path $env:TEMP ("listagent-package-" + [guid]::NewGuid().ToString('N'))
$payload = Join-Path $stage 'listagent'
$items = @('src', 'renderer', 'scripts', 'node_modules', 'models', 'package.json', 'package-lock.json', 'README.md', 'start-listagent.cmd', 'uninstall-listagent.cmd', 'uninstall-listagent.ps1')
try {
  New-Item -ItemType Directory -Path $payload -Force | Out-Null
  foreach ($item in $items) {
    $source = Join-Path $root $item
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $payload $item) -Recurse -Force }
  }
  $destination = [System.IO.Path]::GetFullPath($OutputPath)
  New-Item -ItemType Directory -Path ([System.IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
  if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Force }
  Compress-Archive -Path (Join-Path $payload '*') -DestinationPath $destination -CompressionLevel Optimal
  Write-Host "Portable package written to $destination"
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
