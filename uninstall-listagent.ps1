[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$installRoot = [System.IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
$packagePath = Join-Path $installRoot 'package.json'

if (-not (Test-Path -LiteralPath $packagePath)) {
  throw "listagent installation directory not found: $installRoot"
}
if ($installRoot -match '^[A-Za-z]:$' -or $installRoot -eq '\\') {
  throw "Refusing to delete a filesystem root."
}

Write-Host "This will remove this listagent installation: $installRoot" -ForegroundColor Yellow
Write-Host 'It also removes this version registration and all files under data and .runtime.' -ForegroundColor Yellow
Write-Host 'This cannot be undone. Type DELETE to continue.' -ForegroundColor Yellow
if ((Read-Host 'Confirmation') -cne 'DELETE') {
  Write-Host 'Uninstall cancelled.'
  exit 1
}

$registryKey = 'HKCU\Software\Classes\*\shell\ListagentDelete'
$commandKey = "$registryKey\command"
$registryText = (& reg.exe QUERY $commandKey /ve 2>$null | Out-String)
$registryPattern = [regex]::Escape($installRoot)
if ($registryText -and $registryText -match $registryPattern) {
  & reg.exe DELETE $registryKey /f | Out-Null
  Write-Host 'Explorer context-menu registry changes restored.' -ForegroundColor Green
} else {
  Write-Host 'No context-menu entry for this version was found; other versions were not changed.'
}

# Remove the Windows logon entry only when it points to this installation.
# This keeps a second listagent copy (for example the C: and E: versions)
# untouched.
$runKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\Run'
$runRegistryPath = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run'
$startupNames = @()
$runProperties = Get-ItemProperty -LiteralPath $runRegistryPath -ErrorAction SilentlyContinue
if ($runProperties) {
  $startupNames = @($runProperties.PSObject.Properties |
    Where-Object { $_.Name -notmatch '^PS' -and [string]$_.Value -match $registryPattern } |
    Select-Object -ExpandProperty Name)
}
foreach ($startupName in $startupNames) {
  Remove-ItemProperty -LiteralPath $runRegistryPath -Name $startupName -Force -ErrorAction SilentlyContinue
}
if ($startupNames.Count -gt 0) {
  Write-Host 'Windows startup entry for this version restored.' -ForegroundColor Green
} else {
  Write-Host 'No startup entry for this version was found; other versions were not changed.'
}

$processPattern = [regex]::Escape($installRoot)
Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match $processPattern } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

$escapedRoot = $installRoot.Replace("'", "''")
$cleanup = @"
`$target = '$escapedRoot'
for (`$i = 0; `$i -lt 30; `$i++) {
  try {
    if (-not (Test-Path -LiteralPath `$target)) { break }
    Remove-Item -LiteralPath `$target -Recurse -Force -ErrorAction Stop
    if (-not (Test-Path -LiteralPath `$target)) { break }
  } catch { Start-Sleep -Milliseconds 500 }
}
"@
Start-Process -FilePath 'powershell.exe' -WorkingDirectory $env:TEMP -WindowStyle Hidden -ArgumentList @(
  '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cleanup
)
Write-Host 'Cleanup started. The installation directory will be removed after this script exits.' -ForegroundColor Green
exit 0
