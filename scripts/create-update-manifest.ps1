[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$Repository,
  [Parameter(Mandatory = $true)][string]$Tag,
  [string]$SourceRoot = ''
)

$ErrorActionPreference = 'Stop'
$root = if ($SourceRoot) { [System.IO.Path]::GetFullPath($SourceRoot) } else { [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
$output = [System.IO.Path]::GetFullPath($OutputPath)
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$items = @('src', 'renderer', 'scripts', 'models', 'package.json', 'package-lock.json', 'README.md', 'start-listagent.cmd', 'uninstall-listagent.cmd', 'uninstall-listagent.ps1')
$files = [System.Collections.Generic.List[object]]::new()

foreach ($item in $items) {
  $source = Join-Path $root $item
  if (-not (Test-Path -LiteralPath $source)) { continue }
  $candidates = if ((Get-Item -LiteralPath $source).PSIsContainer) { Get-ChildItem -LiteralPath $source -File -Recurse } else { Get-Item -LiteralPath $source }
  foreach ($file in $candidates) {
    $relative = [System.IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/')
    $segments = $relative.Split('/') | ForEach-Object { [System.Uri]::EscapeDataString($_) }
    $rawUrl = "https://raw.githubusercontent.com/$Repository/$Tag/$($segments -join '/')"
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $files.Add([ordered]@{ path = $relative; size = [int64]$file.Length; sha256 = $hash; url = $rawUrl })
  }
}

$manifest = [ordered]@{
  schema = 1
  repository = $Repository
  tag = $Tag
  version = [string]$package.version
  runtime = [ordered]@{ electron = [string]$package.devDependencies.electron }
  generatedAt = [DateTime]::UtcNow.ToString('o')
  files = $files
}
$json = $manifest | ConvertTo-Json -Depth 8 -Compress
$parent = Split-Path -Parent $output
New-Item -ItemType Directory -Path $parent -Force | Out-Null
[System.IO.File]::WriteAllText($output, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Incremental update manifest written to $output ($($files.Count) files)."
